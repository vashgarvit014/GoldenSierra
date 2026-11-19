# PULLOVER_OG — Golden Sierra Workforce Navigator: everything done so far

Handoff document. Covers what was built, how it runs, what was fixed and why, and what is still open.
Period: 2026-11-12 → 2026-11-16. Repo: `https://github.com/vashgarvit014/GoldenSierra.git` (branch `main`).
No secrets are recorded here; keys live in `.env` (git-ignored).

---

## 1. What the product is

A production RAG chatbot for Golden Sierra Job Training Agency (Placer, El Dorado, Alpine counties).
Visitors describe their situation (for themselves, or helping someone); the assistant understands first,
asks one useful question at a time, then recommends services with sources. Staff run an admin console to
manage the knowledge base. Eligibility is never decided by the model — published rules decide, and every
recommendation that needs it says "Staff confirm".

## 2. Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, Turbopack), React 19, TypeScript strict, Tailwind v4 |
| DB | PostgreSQL 16 via Prisma 6.19.3 (Docker, host port **5433**) |
| Vectors | Qdrant 1.12.4, collection `gs_knowledge`, 384-dim cosine (Docker) |
| Queue | BullMQ on Redis 7 (Docker); worker supervised by launchd |
| LLM | Inception Labs `mercury-3` (OpenAI-compatible; no embeddings endpoint) |
| Embeddings | `Xenova/bge-small-en-v1.5`, local in-process (`@huggingface/transformers`) |
| Retrieval | Hybrid vector + keyword, Reciprocal Rank Fusion (k=60), heading-aware chunking, LLM rerank with heuristic fallback |
| Tests | Vitest (206 unit), Playwright with real Chrome (e2e) |

Design rule throughout: **deterministic code decides, the LLM phrases.**

## 3. Running it

```
docker compose up -d                  # postgres :5433, qdrant :6333, redis :6379
PORT=3100 npm run dev                 # chat: http://localhost:3100   admin: /admin
./deploy/install-worker.sh            # ingestion worker as a launchd agent (once)
npm test                              # 206 unit tests
npm run reclassify                    # dry-run audience/category recompute (--apply to write)
```

Plain `npm run dev` binds 3000, which is occupied on this machine — always set `PORT=3100`.
To stop the dev server use `pkill -f next-server` (it is not named `next dev`).
Worker: `launchctl print gui/$UID/com.goldensierra.worker`, logs in `logs/worker.log`.

## 4. Timeline of work

1. **Initial build** (`f36b520`) — from a 20-section master spec: crawler, PDF ingestion, Qdrant, Postgres,
   admin dashboard, eligibility engine, consolidated response engine, evaluation suite.
2. **Provider wiring** (`e273c5e`) — Inception `mercury-3` for answers; local BGE embeddings; retrieval
   quality fixes (see §6).
3. **Vercel** (`ad4e8d9`, `73f9433`, `166e1f1`) — fixed build failure (embedding stack too large for
   serverless), documented constraints, fixed a 500 caused by an unhandled Redis error.
4. **Live verification** (`4e082d2`, `8f32432`) — read-only forensic audit of the uploaded `Scrapedata.pdf`
   (no KB data modified), Playwright browser walkthrough with report, audience-misclassification fix
   re-verified in Chrome.
5. **Console UI port** (`6aa042a`) — user's `golden_sierra_ui.html` ported into the live admin console,
   every panel backed by a real API.
6. **Counselor mode** (`076197a`) — adaptive conversation: extract context, ask one question at a time,
   honest narrowing counts ("N of 12", never a fabricated total), quick replies.
7. **Enhance in place** (`e87439a`) — user reversed course: no separate app, no reference replica. The
   counselor engine now drives the *existing* chat panel; context shown as a compact collapsible strip.
   Fixed the job-listing audience defect (§6).
8. **Question gating** (`eb44e39`) — stop recommending before decisive questions are answered; no
   duplicate result sets.
9. **Ingestion queue** (`a54de2e`) — jobs sat "queued" for 3 days because no worker was running; made a
   stalled queue visible and survivable.
10. **Supervised worker** (`6bbff70`) — launchd agent, Redis singleton lease, atomic job claim, retry bounds.
11. **Golden Sierra branding** (`20722a0`) — removed the assumption notice; one token system across chat
    and admin, based on goldensierra.com. **Committed locally, not pushed.**

## 5. Architecture notes

- **Chat flow**: `POST /api/session` → `src/lib/counselor/engine.ts`
  - `extract.ts` — rule-based extraction first, LLM refines; rule matches are authoritative for
    transportation.
  - `questions.ts` — next question by information gain (normalised entropy); a question can be asked at
    most twice; `readyForResults` waits on the decisive ones (transport, income urgency).
  - `matching.ts` — four-state eligibility (`eligible / potential / needs_verification / mismatch`);
    absence of evidence never excludes.
  - Once nothing useful is left to ask, stage goes straight to `results`.
- **Retrieval**: audience is a hard filter; county is a ranking boost (Qdrant `should` is required, so it
  cannot be an optional filter).
- **Ingestion**: `src/lib/ingest/` (crawler, clean, chunk, pipeline, queue). Crawler respects robots.txt,
  normalises URLs, applies include/exclude patterns to sitemap seeds too.
- **Admin**: `/admin` is a single-page console (7 tabs); `/admin/{sources,programs,testing,config}` are
  separate pages sharing `AdminShell`. Auth is enforced server-side (`requireAdmin`).
- **Job claim**: `runJob` atomically claims a row (`QUEUED`/`FAILED`, or `RUNNING` older than 30 min) so
  duplicate deliveries cannot double-process.
- **Worker singleton**: Redis lease `gs-ingestion:worker-lock` (30 s TTL, renewed), `lockDuration` 5 min,
  `maxStalledCount` 2, 2 attempts with exponential backoff.

## 6. Defects found and fixed (root cause → fix)

| Defect | Root cause | Fix |
|---|---|---|
| Qdrant search failed | `search` removed in client | use Query API |
| Qdrant point IDs rejected | IDs must be UUID/int | UUIDv5 from chunk id |
| Sibling sections merged into one chunk | "shares top-level heading" test | ancestor-or-same check |
| Keyword retrieval `Bad Request` | missing full-text payload index | create index |
| Sitemap URLs bypassed patterns | patterns only on crawled links | apply `shouldCrawl` to seeds |
| "scholarships" not matched | singular-only regex | plural-aware patterns |
| Overclaim softener lowercased sentences | naive replace | `matchCase()` |
| Structured output returned `{}` | reasoning tokens starved `max_tokens` | `REASONING_HEADROOM_TOKENS=600` |
| Vercel 500 | ioredis error event unhandled | error listener, fail-fast, latched fallback |
| Local dev silently on prod DB | `vercel link` wrote `.env.local` | renamed to `.env.vercel-pulled` |
| Job-listing PDFs invisible to job seekers | "Employer" column label classified them `employer` (hard filter) | detect listings structurally; employer = addressed *to* employers; `reclassify.ts` (7 docs, 64 chunks) |
| Results fired early / duplicated | "asked" treated as "answered" | allow one re-ask, decisive questions survive threshold, only newest results render cards |
| Jobs queued 3 days | no worker; `queue.add()` failure stranded row | worker as launchd agent; inline fallback; queue health in UI |
| PDF/DELETE jobs stuck RUNNING | failure path never set `FAILED` | try/catch marks `FAILED` (live failing-job run **not** done) |
| "No reliable transport" → "transit only" | LLM value overwrote rule match | rule value wins |
| Admin sub-pages unframed; mobile overflow | no shell; unwrapped badges | `AdminShell`, wrap fixes |

## 7. Data state (last verified 2026-11-16)

- 160 documents, 780 chunks in Postgres, 780 points in Qdrant, 0 missing vectors, collection green.
- 12 active programs (catalogue size — counts are always "N of 12").
- Public-website source: 157 docs; `/venue`, `/series`, `/organizer` excluded (sitemap is ~1,680 URLs,
  mostly `/event` and `/blog`); 150-page cap deliberately **not** raised.
- Queue: 0 waiting, 1 worker connected.

## 8. Branding (final pass)

- Reference: goldensierra.com/about and /. Verified values: gold `#ffc425`, charcoal `#231f20`, tobacco
  `#6e5740`, canvas `#f0eeeb`, Barlow 400/700/900, pill buttons with 2 px border, 16 px flat cards.
- Tokens in `src/app/globals.css` (primitives `--gs-*`, semantic `--primary`, `--surface`, `--muted`,
  `--border`, `--input`, `--focus`, `--success`, `--warning`, `--destructive`, `--ink`, `--accent`).
  Approximations (AA-safe muted text, status tints, input outline) are marked in the CSS.
- Contrast asserted in `tests/unit/theme.test.ts`. Light-only (dark forks removed).
- Logo: `public/brand/golden-sierra-logo*.svg` (official artwork); `src/app/icon.svg` derived from its mark.
- Assumption notice removed from the UI; the engine still computes it internally.

## 9. Verification evidence

- 206 unit tests pass (`npm test`).
- Live Chrome scenario `tests/e2e/counselor-scenario.ts`: 20/20.
- Responsive/a11y sweep `tests/e2e/theme-verify.ts`: 14 pages × 375/768/1024/1440 — 0 overflow,
  0 unlabelled controls, 0 console errors from our code. Production build verified.
- Screenshots (local, git-ignored): `test-artifacts/theme/{before,final}/`.
- Other e2e scripts in `tests/e2e/` (live RAG walkthrough, store verification) contain stale expectations
  (e.g. 40 documents) from earlier phases — update before reuse.

## 10. Standing constraints from the user

- Never bypass the reference prototype's access-code gate (it returns 307 → "Access code").
- Do not modify/delete KB data unless explicitly told; avoid destructive DB operations; no unnecessary
  reindexing or re-crawling.
- Never expose API keys, DB credentials or tokens in logs, videos or reports.
- No fabricated counts; do not claim PASS without runtime evidence.
- Keep reports concise.

## 11. Open items / known issues

1. **Not pushed**: commit `20722a0` (branding) exists locally only.
2. "Why this fits" on every card reads "Available in Placer County" — the county rule outranks more
   specific reasons in `matchPrograms`. Cosmetic.
3. Live failing-PDF-job test for the `FAILED` fix was not run (would touch ingestion).
4. launchd covers this Mac only; production needs a managed worker (no Dockerfile yet). Reboot restart is
   inferred from `RunAtLoad`, not tested.
5. Public site has no branded footer (by design; disclaimer + phone only).
6. Public-website crawl still covers ~150 of ~650 eligible pages; `/blog` (≈600) inclusion is a product
   decision.
7. Dev-only noise: Next "negative time stamp" error; 401 logged on signed-out `/admin`.
8. Comparison with goldensierra.com was visual, not pixel-diffed.
9. Admin test credentials in e2e scripts default to a local test account — rotate before any shared use.

## 12. Where things live

```
src/app/                 routes, globals.css (tokens), console.css (admin)
src/components/chat/     ChatPanel, MessageBubble, RecommendationCard, Markdown
src/components/admin/    AdminShell, forms, SourcesManager, TestConsole
src/components/console/  admin SPA (Console + pages/*)
src/lib/counselor/       engine, extract, questions, matching
src/lib/ingest/          crawler, clean, chunk, pipeline, queue
src/lib/status.ts        job/document status → CSS class
scripts/                 worker.ts, reclassify.ts, ingest.ts, eval.ts, create-admin.ts
deploy/                  launchd plist + install-worker.sh
docs/                    BEHAVIOR-SPEC, DEPLOYMENT, VERCEL, VERIFICATION
tests/unit, tests/e2e    Vitest + Playwright
```
