# Golden Sierra Workforce Navigator

A retrieval-grounded AI assistant for Golden Sierra Job Training Agency, which
administers publicly funded workforce development programs in **Placer, El
Dorado and Alpine counties, California**.

It answers natural-language questions about job search help, training,
scholarships, paid internships, career counseling, and employer hiring support
— using information retrieved from the agency's own published pages and
documents, with citations and next steps.

It is **not** a general chatbot with a workforce-shaped prompt. Every factual
claim is traced to a retrieved source, eligibility is decided by deterministic
rules rather than by the model, and an answer that cannot be grounded says so.

---

## ⚠️ Read this first: what was and was not verified

**The reference Workforce Navigator prototype was not observed.**
`golden-sierra-git-develop-golden-sierra.vercel.app/results?mode=self&demo=1`
is behind an access-code gate ("This isn't public yet"). As instructed, that
gate was not bypassed. No conversation, response format, or recommendation
layout from the reference tool was seen.

Consequently:

- Conversation flow, tone, response structure and follow-up behaviour in this
  implementation are derived from the **public goldensierra.com content** and
  the project brief. They are a **documented, configurable starting point**
  (`src/lib/ai/prompts.ts` → `RESPONSE_STYLE`), not a verified replication.
- **No claim of behavioural parity with the reference tool is made.** To
  establish parity, load real reference transcripts as `EvalCase` rows and tune
  against them with `npm run eval`. See [docs/BEHAVIOR-SPEC.md](docs/BEHAVIOR-SPEC.md).

Everything was exercised against live services — the real goldensierra.com
crawl, real PostgreSQL, real Qdrant, and real `mercury-3` generation. What was
verified and what was not is listed in
[docs/VERIFICATION.md](docs/VERIFICATION.md). Please read it before deploying.

---

## What it does

```
User question
   ↓
Query understanding      intent, standalone rewrite, volunteered facts
   ↓
Hybrid retrieval         dense vectors + keyword match, fused with RRF
   ↓
Reranking                cross-encoder → LLM → lexical heuristic
   ↓
Consolidation            dedupe, conflict detection, freshness ordering
   ↓
Program matching         deterministic eligibility rules from PostgreSQL
   ↓
Grounded generation      one consolidated answer, streamed
   ↓
Verification             citation repair, overclaim softening, grounding check
   ↓
Answer + recommendations + citations + next steps + follow-ups
```

### Design decisions worth knowing

| Decision | Why |
|---|---|
| Eligibility is evaluated in code, never by the model | An approval the model invents is indistinguishable from a real one. The engine returns `met` / `unmet` / `unknown`, and `unknown` is the common case. |
| No match percentage is shown | There is no validated scoring model. A number would read as a measurement when it would really be a guess. |
| Unverified rules cannot exclude anyone | A rule with no published source URL is treated as undecidable, never as a requirement. |
| County is a ranking boost, not a filter | Most agency pages name no county. Filtering on it would hide most of the corpus. |
| Structured program facts come from PostgreSQL | Program status, contacts and eligibility are records, not things to infer from a vector match. |
| Retrieved text is untrusted input | Page content is sanitised and explicitly framed as evidence, never as instructions. |

---

## Quick start

**Prerequisites:** Node 20+, Docker, and a chat-model API key.

```bash
# 1. Install
npm install

# 2. Start PostgreSQL, Qdrant and Redis
docker compose up -d

# 3. Configure
cp .env.example .env
# Required in .env:
#   AUTH_SECRET — openssl rand -base64 48
#   LLM_API_KEY — your chat provider key
#
# Defaults are set for Inception Labs (mercury-3) with embeddings running
# locally, so no second provider key is needed. See "Models" below.

# 4. Create the schema and seed programs, categories and eval cases
npm run db:migrate
npm run db:seed

# 5. Create the Qdrant collection
npm run vector:init

# 6. Create an admin user
ADMIN_PASSWORD='choose-a-strong-one' npm run admin:create -- --email=you@example.com --role=ADMIN

# 7. Crawl and index goldensierra.com
npm run ingest

# 8. Confirm everything is wired up
npm run setup

# 9. Run it
npm run dev
```

- Chatbot: <http://localhost:3000>
- Admin dashboard: <http://localhost:3000/admin>

> **Port note:** if something already occupies 5432 or 3000 locally, the
> compose file maps PostgreSQL to **5433** to avoid clobbering an existing
> instance. Run Next.js elsewhere with `PORT=3100 npm run dev`.

### Running without an LLM key

The app boots and the admin dashboard, crawler and database work normally.
The chatbot still classifies intent, extracts profile facts and produces
deterministic program recommendations — it returns the agency's contact
details instead of a written answer. The dashboard shows a banner saying so.

---

## Configuration

All configuration is environment-driven and validated at boot
(`src/lib/env.ts`); a misconfigured deployment fails immediately rather than
mid-conversation. See [`.env.example`](.env.example) for the full annotated list.

### Models

**Chat — Inception Labs `mercury-3`** (default). A diffusion LLM with a 1M
context window, JSON mode and structured outputs. Being diffusion-based it
streams in a few large blocks rather than token-by-token — the UI handles
this, but the typing effect is steppy. It is also a reasoning model, so
reasoning tokens are charged against `max_tokens`; every structured call adds
`REASONING_HEADROOM_TOKENS` on top of its expected output.

Reached over the standard OpenAI protocol, so switching provider is a
base-URL and model-name change with no code change:

```bash
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# OpenRouter
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-sonnet-4.5
```

**Embeddings — local BGE** (default). Inception Labs serves only
`chat.completions` and has **no embeddings endpoint**, which RAG requires. So
rather than depend on a second paid provider to vectorise a few hundred pages,
`EMBEDDING_PROVIDER=local` runs `Xenova/bge-small-en-v1.5` in-process via
Transformers.js — 384 dimensions, ~33MB, no API key, no per-query cost.

The model is warmed at server start (`src/instrumentation.ts`) because a cold
load takes ~30–40s; warm, a query embeds in single-digit milliseconds.

To use a hosted embedding provider instead:

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=…
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

BGE models are asymmetric — queries carry an instruction prefix, passages do
not. `embedQuery()` applies it automatically; skipping it costs real recall.

> **Changing the embedding model requires a re-index.** Vector dimensions must
> match the collection; startup refuses to proceed on a mismatch rather than
> silently corrupting search. Either use a new `QDRANT_COLLECTION` name or run
> `npm run ingest -- --reindex`.

Retrieval and generation parameters (top-K, min score, chunk size, temperature)
are tunable at runtime from **Admin → AI configuration**. API keys and
endpoints deliberately are not — credentials must not be readable or writable
over HTTP.

---

## Knowledge ingestion

```bash
npm run ingest                      # crawl every active source
npm run ingest -- --source=<id>     # one source
npm run ingest -- --reindex         # re-embed existing documents
npm run ingest -- --url=<pdf-url>   # ingest a single PDF
```

The crawler:

- seeds from the site's XML sitemap, then follows internal links;
- **only visits hosts listed in `CRAWL_ALLOWED_HOSTS`** — an admin cannot widen
  this from the dashboard;
- respects `robots.txt`, rate-limits, and retries transient failures;
- never attempts to bypass a login, CAPTCHA, or access control — a 401/403 is
  logged and skipped;
- skips unchanged pages by content hash, so re-crawling costs nothing in
  embedding spend;
- extracts linked PDFs;
- deletes a document's old vectors *before* writing new ones, so a crash
  leaves content unsearchable rather than half-stale.

Background jobs run through BullMQ when `REDIS_URL` is set
(`npm run ingest:worker`), and in-process otherwise.

---

## Testing

```bash
npm test          # 117 tests: 109 unit + 8 against live Qdrant
npm run typecheck
npm run eval      # reference evaluation suite (needs an LLM key + indexed data)
```

The integration suite runs against **real Qdrant** using a deterministic local
embedding function, so it verifies storage, metadata filtering, access-level
enforcement and deletion without needing a provider key. It skips itself
automatically when Qdrant is unreachable.

`npm run eval` scores answers on nine dimensions (intent, recommendation
relevance, source accuracy, grounding, fabrication guards, actionability,
length, consolidation) and prints a **baseline** — not a pass/fail against
invented thresholds. Set CI thresholds from numbers you have actually observed.
Fabrication failures alone exit non-zero.

The observed baseline on this corpus is recorded in
[docs/VERIFICATION.md](docs/VERIFICATION.md). Two of the original eval cases
turned out to be wrong rather than the system — worth reading before trusting
any score.

---

## Project layout

```
prisma/schema.prisma          PostgreSQL schema (19 models)
prisma/seed.ts                Programs, categories, sources, eval cases
src/lib/
  env.ts                      Validated configuration
  auth.ts  session.ts         Admin RBAC; anonymous chat sessions
  ai/        client, embeddings, prompts (RESPONSE_STYLE lives here)
  vector/    Qdrant: filters, lifecycle, reconciliation
  ingest/    crawler, extract, pdf, clean, chunk, pipeline, queue
  rag/       understand, retrieve, rerank, consolidate, generate
  programs/  eligibility (deterministic), matching
  eval/      reference evaluation runner
src/app/api/                  Chat, programs, and admin endpoints
src/app/admin/                Dashboard: overview, sources, programs, testing, config
src/components/chat/          Chat UI, streaming, recommendations, citations
docs/                         Verification report, behaviour spec, deployment
```

---

## API

**Public**

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | Streams an answer (NDJSON: `meta` → `token`… → `done`) |
| `POST /api/chat/session` | Starts an anonymous conversation |
| `GET /api/chat/session/:id` | Replays a conversation (token required) |
| `DELETE /api/chat/session/:id` | Ends it; `?purge=true` erases it |
| `POST /api/chat/feedback` | Records a helpful / not-helpful rating |
| `GET /api/programs` | Program catalogue (filterable) |
| `GET /api/programs/:id` | One program, by id or slug |

**Admin** (session cookie; `VIEWER` / `EDITOR` / `ADMIN` roles)

`/api/admin/auth/{login,logout}` · `/api/admin/sources` · `/api/admin/ingestion`
· `/api/admin/ingestion/status` · `/api/admin/documents` ·
`/api/admin/documents/upload` · `/api/admin/programs` · `/api/admin/analytics`
· `/api/admin/config` · `/api/admin/test-query`

---

## Privacy

Conversations are anonymous. There is no user account, and the session token
held by the browser is the only credential that can read a conversation back.

The assistant extracts **only workforce-relevant facts a person volunteers** —
county, employment situation, career interests, veteran status — and is
explicitly instructed never to extract names, addresses, phone numbers, email
addresses or dates of birth. IP and user-agent are stored as salted hashes for
abuse handling only. Conversations are deleted after `CHAT_RETENTION_DAYS`
(default 30) via `purgeExpiredSessions()`.

Conversation data lives in PostgreSQL and never in the vector index, which is
shared across all users.

---

## Attribution

This is an original implementation. No logo, branding asset, stylesheet or
source code from goldensierra.com or the reference prototype is reproduced.
Program names, descriptions and contact details are **facts transcribed from
public pages**, each cited in `prisma/seed.ts` with the URL it came from and
the date it was read (2026-11-12).

Further reading: [docs/VERIFICATION.md](docs/VERIFICATION.md) ·
[docs/BEHAVIOR-SPEC.md](docs/BEHAVIOR-SPEC.md) ·
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
