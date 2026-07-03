import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.95.1";
import {createClient} from "jsr:@supabase/supabase-js@2.49.4";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const openai = new OpenAI({apiKey: OPENAI_API_KEY});

const CHAT_MODEL = "gpt-5.5";
const EMBEDDING_MODEL = "text-embedding-3-small";

// text-embedding-3-small scores relevant matches much lower than older
// embedding models (often 0.2-0.5 cosine similarity, lower still across
// languages), so the floor must be permissive: a dropped relevant chunk is
// far more harmful than an extra irrelevant one the model can ignore.
const MATCH_THRESHOLD = 0.15;
const MATCH_COUNT = 8;

type ChatRequest = {
    prompt?: string;
    chatId?: string | null;
};

type MessageRecord = {
    role: "user" | "assistant" | "system";
    content: string;
};

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

const getRecentMessages = async (
    supabase: ReturnType<typeof buildSupabaseClient>,
    userId: string,
    chatId?: string | null,
) => {
    // A brand-new chat (no id yet) has no prior history. Returning early avoids
    // bleeding messages from the user's *other* chats into this conversation.
    if (!chatId) {
        return [];
    }

    const {data, error} = await supabase
        .from("messages")
        .select("role, content")
        .eq("user_id", userId)
        .eq("chat_id", chatId)
        .order("created_at", {ascending: false})
        .order("role", {ascending: true})
        .limit(10);

    if (error) {
        throw error;
    }

    return ((data ?? []) as MessageRecord[]).reverse();
};

// A follow-up like "what about the second one?" embeds to something
// meaningless on its own, so retrieval misses documents the conversation is
// clearly about. Rewrite the latest message into a standalone question
// before embedding it. On any failure the raw prompt is a fine fallback.
const buildRetrievalQuery = async (
    previousMessages: MessageRecord[],
    prompt: string,
) => {
    if (previousMessages.length === 0) {
        return prompt;
    }

    const history = previousMessages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");

    try {
        const completion = await openai.chat.completions.create({
            model: CHAT_MODEL,
            max_completion_tokens: 300,
            messages: [
                {
                    role: "system",
                    content:
                        "Rewrite the user's latest message as a single standalone question that can be understood without the conversation, resolving pronouns and references. Keep the user's language. Reply with the rewritten question only.",
                },
                {
                    role: "user",
                    content: `Conversation:\n${history}\n\nLatest message:\n${prompt}`,
                },
            ],
        });

        return completion.choices[0]?.message?.content?.trim() || prompt;
    } catch {
        return prompt;
    }
};

// Persists the whole turn atomically: creates the chat if needed and inserts
// both messages in a single transaction, returning the chat id. See the
// save_turn function in schema.sql.
const saveTurn = async (
    supabase: ReturnType<typeof buildSupabaseClient>,
    chatId: string | null | undefined,
    title: string,
    userContent: string,
    assistantContent: string,
) => {
    const {data, error} = await supabase.rpc("save_turn", {
        p_chat_id: chatId ?? null,
        p_title: title,
        p_user_content: userContent,
        p_assistant_content: assistantContent,
    });

    if (error) {
        throw error;
    }

    return data as string;
};

Deno.serve(async (req) => {
    try {
        if (req.method === "OPTIONS") {
            return new Response("ok", {status: 200, headers: corsHeaders});
        }

        if (!OPENAI_API_KEY) {
            return json({error: "OPENAI_API_KEY is not configured"}, 500);
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

        const {prompt, chatId}: ChatRequest = await req.json();
        const trimmedPrompt = prompt?.trim();

        if (!trimmedPrompt) {
            return json({error: "Prompt is required"}, 400);
        }

        const previousMessages = await getRecentMessages(supabase, user.id, chatId);

        const retrievalQuery = await buildRetrievalQuery(
            previousMessages,
            trimmedPrompt,
        );

        const promptEmbedding = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: retrievalQuery,
        });

        const {data: contextDocs, error: contextError} = await supabase.rpc(
            "match_documents",
            {
                query_embedding: promptEmbedding.data[0].embedding,
                match_threshold: MATCH_THRESHOLD,
                match_count: MATCH_COUNT,
                filter_user_id: user.id,
            },
        );

        if (contextError) {
            throw contextError;
        }

        const contextText = (
            (contextDocs ?? []) as Array<{content: string; file_name?: string}>
        )
            .map((doc, index) => {
                const source = doc.file_name ? ` (from ${doc.file_name})` : "";
                return `[${index + 1}]${source}\n${doc.content}`;
            })
            .join("\n\n");

        const completion = await openai.chat.completions.create({
            model: CHAT_MODEL,
            temperature: 1,
            max_completion_tokens: 2000,
            messages: [
                {
                    role: "system",
                    content: `
Your name is RAGify AI. You answer questions using excerpts retrieved from the user's uploaded documents.

### Task:
Answer the user's query using the document excerpts provided as context.

### Guidelines:
- The context contains excerpts from the user's own files. They may be partial, unordered, or include irrelevant passages — use whatever is relevant.
- When the context and your general knowledge conflict, prefer the context.
- If the context does not contain the information needed, say that the uploaded documents do not appear to cover it. Do not invent details.
- Greetings and small talk need no context — just respond naturally.
- Respond in the same language as the user's query.
          `.trim(),
                },
                ...previousMessages,
                {
                    role: "user",
                    content: `Context from the user's documents:
${contextText || "(no relevant excerpts were found in the user's documents)"}
---
User Query:
${trimmedPrompt}`,
                },
            ],
        });

        const assistantResponse = completion.choices[0]?.message?.content?.trim();

        if (!assistantResponse) {
            throw new Error("Model returned an empty response");
        }

        // Persist the chat (if new) and both messages in one transaction so a
        // failure can never leave a half-written turn. The DB function also
        // stamps the two messages with distinct, ordered timestamps.
        const currentChatId = await saveTurn(
            supabase,
            chatId,
            trimmedPrompt,
            trimmedPrompt,
            assistantResponse,
        );

        return json({
            content: assistantResponse,
            chatId: currentChatId,
        });
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : "An unexpected error occurred";

        return json({error: message}, 500);
    }
});
