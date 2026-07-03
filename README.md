# RAGify AI

Polished Astro chatbot frontend with Supabase email/password authentication,
chat history, message history, per-user uploaded files used as retrieval
context, and Supabase Edge Function completion calls.

## Per-user knowledge base

Each signed-in user uploads their own files from the sidebar. Files are stored
in a private `documents` Storage bucket under a per-user folder (`<uid>/<name>`)
and chunked + embedded by the `generate-embeddings` Edge Function into
`public.documents` (scoped by `user_id`). The chat (`ai-chat`) only retrieves
context from the calling user's own documents, nothing is shared between users.
Row Level Security on both the table and the bucket enforces this isolation.

## Environment

Create a local `.env` from `.env.example`:

```sh
PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
PUBLIC_SUPABASE_CHAT_FUNCTION=chat
PUBLIC_SUPABASE_EMBED_FUNCTION=generate-embeddings
```

`PUBLIC_SUPABASE_CHAT_FUNCTION` / `PUBLIC_SUPABASE_EMBED_FUNCTION` should match
your deployed Supabase Edge Function names. The included reference chat function
accepts:

```json
{ "prompt": "Your question", "chatId": "optional-existing-chat-id" }
```

and returns:

```json
{ "content": "Assistant response", "chatId": "chat-id" }
```

## Commands

```sh
npm install
npm run dev
npm run build
npm run preview
```

Set `OPENAI_API_KEY` (and the auto-provided `SUPABASE_URL` / `SUPABASE_ANON_KEY`)
as Edge Function secrets. Apply `supabase/schema.sql` to your database before
first use, it creates the per-user `documents` table, the `match_documents`
function, the private `documents` Storage bucket, and all Row Level Security
policies.
