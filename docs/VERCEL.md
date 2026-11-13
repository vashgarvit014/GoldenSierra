# Deploying to Vercel

**Short version:** Vercel can host the *chatbot*. It cannot host the
*ingestion pipeline*, and it cannot run the default local embedding model.
Plan for Vercel + three managed services, and run crawling from somewhere else.

If you want one place that does everything, use a container host instead —
see [DEPLOYMENT.md](DEPLOYMENT.md) for Cloud Run.

---

## The build failure, and what fixed it

```
Error: Failed to collect configuration for /api/admin/config
  [cause]: Invalid environment configuration:
    - DATABASE_URL: Invalid input: expected string, received undefined
```

`src/lib/env.ts` validated configuration at **module import**. `next build`
imports every route module to collect its metadata, so the build demanded
production secrets that a build step has no business needing.

Validation is now deferred to first property access (`env` is a lazy Proxy),
and enforced instead at server start via `assertEnv()` in
`src/instrumentation.ts`. A misconfigured deployment still fails loudly — at
boot, where it belongs — and the build no longer needs secrets at all.

---

## What cannot run on Vercel

### Local embeddings — hard size limit

| Package | Size |
|---|---|
| `@huggingface/transformers` | 279 MB |
| `onnxruntime-node` | 288 MB |
| cached BGE model | 266 MB |
| **Vercel function limit** | **250 MB** |

Not a tuning problem. These are excluded from serverless bundles in
`next.config.ts` (`outputFileTracingExcludes`), and `local-embeddings.ts`
throws an actionable error rather than a bare `MODULE_NOT_FOUND` if something
reaches that path.

**You must use a hosted embedding provider on Vercel.** Inception Labs does
not serve embeddings, so this needs a second provider.

### Ingestion — wrong execution model

Crawling takes minutes and writes progress as it goes. A serverless function
is frozen once it responds, so the in-process job runner cannot work. Run
`npm run ingest` from a CLI, a container, or a scheduled job with Redis and a
separate worker.

`maxDuration` on the four long routes was lowered from 300/120 to **60**,
since anything above 60 fails deployment on Hobby outright.

---

## Required services

| Need | Options |
|---|---|
| PostgreSQL | Neon, Supabase, Vercel Postgres |
| Qdrant | Qdrant Cloud |
| Embeddings | OpenAI, Voyage, Cohere, Jina — anything OpenAI-compatible |
| Chat model | Inception `mercury-3` (works as-is) |
| Redis *(optional)* | Upstash — only if you want queued ingestion |

## Environment variables

Set in Vercel → Settings → Environment Variables:

```bash
DATABASE_URL=postgresql://…         # pooled connection string
QDRANT_URL=https://xxx.cloud.qdrant.io:6333
QDRANT_API_KEY=…
AUTH_SECRET=…                        # openssl rand -base64 48

LLM_PROVIDER=inception
LLM_BASE_URL=https://api.inceptionlabs.ai/v1
LLM_MODEL=mercury-3
LLM_API_KEY=…

# NOT 'local' — see above.
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=…
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536

APP_URL=https://your-app.vercel.app
CRAWL_ALLOWED_HOSTS=goldensierra.com,www.goldensierra.com
```

> **Changing the embedding model requires a full re-index.** The current index
> is 384-dimensional (BGE); `text-embedding-3-small` is 1536. Use a fresh
> `QDRANT_COLLECTION` name or delete the old collection, then re-ingest.
> Startup refuses to run against a dimension-mismatched collection rather than
> corrupting search.

## Deploy

```bash
# 1. Point the schema at the managed database and migrate
DATABASE_URL='postgresql://…' npx prisma migrate deploy
DATABASE_URL='postgresql://…' npm run db:seed

# 2. Build the index from a machine that can run long jobs
#    (local, container, or CI — not Vercel)
npm run vector:init
npm run ingest

# 3. Deploy
vercel --prod
```

Vercel serves chat against the index those steps produced. Re-run step 2
whenever the source content changes.
