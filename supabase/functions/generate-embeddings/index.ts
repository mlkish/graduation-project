import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.95.1";
import {createClient} from "jsr:@supabase/supabase-js@2.49.4";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const BUCKET = "documents";

const openai = new OpenAI({apiKey: OPENAI_API_KEY});

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type StorageDocument = {
    name: string;
};

type EmbedRequest = {
    // A single file (bare name, e.g. "notes.txt") to (re)embed. The user's id
    // is prepended server-side, so a user can only ever index their own files.
    fileName?: string;
    // When true and no fileName is given, re-embed every file the user owns.
    reindex?: boolean;
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
        },
    });

const buildSupabaseClient = (req: Request) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: req.headers.get("Authorization") ?? "",
            },
        },
    });

// Splits on line breaks first and sentence boundaries second, so lists,
// headings, and line-based notes (which rarely contain ". ") no longer
// collapse into one giant chunk. Any single segment longer than chunkSize is
// hard-split, so every chunk stays well under the embedding model's input
// limit.
class TextSplitter {
    constructor(
        private readonly chunkSize: number,
        private readonly chunkOverlap: number,
    ) {
    }

    splitText(text: string) {
        const segments = this.segment(text);
        const chunks: string[] = [];
        let current: string[] = [];
        let currentLength = 0;

        for (const segment of segments) {
            const wouldOverflow =
                currentLength + segment.length + 1 > this.chunkSize;

            if (current.length > 0 && wouldOverflow) {
                chunks.push(current.join("\n"));

                // Carry trailing segments into the next chunk so facts that
                // straddle a boundary stay retrievable. Segments much larger
                // than the overlap budget are not carried: duplicating them
                // would balloon the next chunk for little retrieval gain.
                const overlap: string[] = [];
                let overlapLength = 0;
                for (
                    let index = current.length - 1;
                    index >= 0 && overlapLength < this.chunkOverlap;
                    index -= 1
                ) {
                    if (current[index].length > this.chunkOverlap * 2) {
                        break;
                    }
                    overlap.unshift(current[index]);
                    overlapLength += current[index].length + 1;
                }

                current = overlap;
                currentLength = overlapLength;
            }

            current.push(segment);
            currentLength += segment.length + 1;
        }

        if (current.length > 0) {
            chunks.push(current.join("\n"));
        }

        return chunks;
    }

    private segment(text: string) {
        const segments: string[] = [];

        for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const sentences = trimmed.length > this.chunkSize
                ? trimmed.split(/(?<=[.!?؟])\s+/)
                : [trimmed];

            for (const sentence of sentences) {
                for (
                    let offset = 0;
                    offset < sentence.length;
                    offset += this.chunkSize
                ) {
                    const piece = sentence
                        .slice(offset, offset + this.chunkSize)
                        .trim();
                    if (piece) {
                        segments.push(piece);
                    }
                }
            }
        }

        return segments;
    }
}

type SupabaseClient = ReturnType<typeof buildSupabaseClient>;

const listUserFiles = async (supabase: SupabaseClient, userId: string) => {
    const {data, error} = await supabase.storage.from(BUCKET).list(userId);

    if (error) {
        throw error;
    }

    return (data ?? [])
        .filter((entry) => entry.name && entry.id !== null)
        .map((entry) => entry.name) as string[];
};

const downloadDocumentText = async (
    supabase: SupabaseClient,
    userId: string,
    fileName: string,
) => {
    const {data, error} = await supabase.storage
        .from(BUCKET)
        .download(`${userId}/${fileName}`);

    if (error) {
        throw error;
    }

    return await data.text();
};

const clearFileEmbeddings = async (
    supabase: SupabaseClient,
    userId: string,
    fileName: string,
) => {
    const {error} = await supabase
        .from("documents")
        .delete()
        .eq("user_id", userId)
        .eq("file_name", fileName);

    if (error) {
        throw error;
    }
};

const insertEmbeddings = async (
    supabase: SupabaseClient,
    rows: Array<{
        user_id: string;
        file_name: string;
        content: string;
        embedding: number[];
    }>,
) => {
    if (rows.length === 0) {
        return;
    }

    const {error} = await supabase.from("documents").insert(rows);

    if (error) {
        throw error;
    }
};

const EMBEDDING_BATCH_SIZE = 64;

const generateEmbeddings = async (inputs: string[]) => {
    const embeddings: number[][] = [];

    for (let start = 0; start < inputs.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
        const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: batch,
        });

        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        embeddings.push(...sorted.map((item) => item.embedding));
    }

    return embeddings;
};

const embedFile = async (
    supabase: SupabaseClient,
    userId: string,
    fileName: string,
    splitter: TextSplitter,
) => {
    const text = await downloadDocumentText(supabase, userId, fileName);
    const chunks = splitter.splitText(text);

    // Generate every embedding BEFORE touching the table. If the embedding API
    // fails partway, the file's previous embeddings are still intact (we have
    // not deleted anything yet), so a failed re-index is a no-op rather than a
    // corruption.
    const embeddings = await generateEmbeddings(chunks);
    const rows = chunks.map((chunk, index) => ({
        user_id: userId,
        file_name: fileName,
        content: chunk,
        embedding: embeddings[index],
    }));

    // Swap old for new: delete the file's previous chunks, then insert all the
    // new ones in a single statement.
    await clearFileEmbeddings(supabase, userId, fileName);
    await insertEmbeddings(supabase, rows);

    return rows.length;
};

Deno.serve(async (req) => {
    try {
        if (req.method === "OPTIONS") {
            return new Response("ok", {status: 200, headers: corsHeaders});
        }

        if (!OPENAI_API_KEY) {
            return json({error: "OPENAI_API_KEY is not configured"}, 500);
        }

        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            return json({
                error: "Supabase environment variables are not configured",
            }, 500);
        }

        const supabase = buildSupabaseClient(req);

        const {
            data: {user},
            error: userError,
        } = await supabase.auth.getUser();

        if (userError) {
            throw userError;
        }

        if (!user) {
            return json({error: "Unauthorized"}, 401);
        }

        const {fileName, reindex}: EmbedRequest = await req.json().catch(() => ({}));
        // ~1200 chars ≈ 300 tokens per chunk: large enough that a chunk
        // carries a self-contained fact with its surroundings, small enough
        // that its embedding stays specific.
        const splitter = new TextSplitter(1200, 200);

        // Determine which of the user's files to (re)embed.
        let targets: string[];

        if (fileName) {
            const trimmed = fileName.trim();
            // Only a bare file name is allowed. Reject anything that could climb
            // out of the user's "<uid>/" folder: path separators or a leading
            // dot (covers ".", "..", "../x", hidden files). Internal dots in a
            // normal name like "report.v2.txt" are fine.
            if (
                !trimmed ||
                trimmed.includes("/") ||
                trimmed.includes("\\") ||
                trimmed.startsWith(".")
            ) {
                return json({error: "Invalid fileName"}, 400);
            }
            targets = [trimmed];
        } else if (reindex) {
            targets = await listUserFiles(supabase, user.id);
        } else {
            return json({error: "fileName is required"}, 400);
        }

        let totalChunks = 0;
        for (const target of targets) {
            totalChunks += await embedFile(supabase, user.id, target, splitter);
        }

        return json({
            message: "Embeddings generated and stored successfully.",
            files: targets.length,
            chunks: totalChunks,
        });
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : "An unexpected error occurred";

        return json({error: message}, 400);
    }
});
