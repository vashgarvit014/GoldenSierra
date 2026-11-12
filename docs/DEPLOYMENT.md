# Deployment

Covers local development, Docker, and Google Cloud Run. Adapt to whatever
infrastructure the agency already runs — nothing here requires Google Cloud
specifically.

---

## Before you deploy

Run through [VERIFICATION.md §5](VERIFICATION.md#5-recommended-steps-before-production).
In particular: **no generated answer has been evaluated yet**. Run
`npm run eval` with real credentials and read the output before going live.

---

## Required services

| Service | Purpose | Required |
|---|---|---|
| PostgreSQL 14+ | System of record | Yes |
| Qdrant 1.10+ | Vector search | Yes |
| Redis 6+ | Background job queue | No — falls back to in-process |
| LLM endpoint | Answer generation | Yes, for answers |
| Embedding endpoint | Indexing and retrieval | Yes, for search |

---

## Environment

Start from [`.env.example`](../.env.example). The must-set values:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/goldensierra
QDRANT_URL=https://your-qdrant-host:6333
QDRANT_API_KEY=…                      # required for any non-local Qdrant
AUTH_SECRET=…                         # openssl rand -base64 48
LLM_API_KEY=…
EMBEDDING_API_KEY=…
APP_URL=https://navigator.example.org
NODE_ENV=production
CRAWL_ALLOWED_HOSTS=goldensierra.com,www.goldensierra.com
```

Configuration is validated at boot (`src/lib/env.ts`), so a missing or
malformed value fails the container start rather than surfacing mid-conversation.

### Secrets

Never commit `.env`. Use your platform's secret manager — Google Secret
Manager, AWS Secrets Manager, Kubernetes secrets. The application reads
credentials only from the environment, and the admin config API refuses to
read or write them, so there is no HTTP path to a key.

Rotating `AUTH_SECRET` invalidates every admin session immediately. That is
the intended way to revoke access in a hurry.

---

## Database

```bash
npm run db:deploy     # prisma migrate deploy — never `migrate dev` in production
npm run db:seed       # idempotent; safe to re-run
npm run vector:init   # creates the Qdrant collection and payload indexes
```

Create the first admin without touching shell history:

```bash
ADMIN_PASSWORD="$(cat /run/secrets/admin_password)" \
  npm run admin:create -- --email=admin@goldensierra.com --role=ADMIN
```

---

## Google Cloud Run

### 1. Dockerfile

Next.js standalone output keeps the image small. Add to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: 'standalone',
  // …existing config
};
```

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma engine + schema are needed at runtime for migrations
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
```

### 2. Build and deploy

```bash
PROJECT=your-gcp-project
REGION=us-west1

gcloud builds submit --tag gcr.io/$PROJECT/gs-navigator

gcloud run deploy gs-navigator \
  --image gcr.io/$PROJECT/gs-navigator \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --set-secrets "DATABASE_URL=gs-database-url:latest,LLM_API_KEY=gs-llm-key:latest,EMBEDDING_API_KEY=gs-embedding-key:latest,AUTH_SECRET=gs-auth-secret:latest,QDRANT_API_KEY=gs-qdrant-key:latest" \
  --set-env-vars "NODE_ENV=production,QDRANT_URL=https://your-qdrant:6333,APP_URL=https://navigator.example.org,CRAWL_ALLOWED_HOSTS=goldensierra.com"
```

`--min-instances 1` avoids a cold start on the first question of the day,
which on a chat interface is the one people notice.

### 3. PostgreSQL

Cloud SQL with the connector:

```bash
gcloud sql instances create gs-navigator-db \
  --database-version=POSTGRES_16 --tier=db-g1-small --region=$REGION

gcloud run services update gs-navigator \
  --add-cloudsql-instances $PROJECT:$REGION:gs-navigator-db
```

Use the socket form in `DATABASE_URL`:

```
postgresql://user:pass@localhost/goldensierra?host=/cloudsql/PROJECT:REGION:gs-navigator-db
```

### 4. Qdrant

Either Qdrant Cloud (set `QDRANT_URL` and `QDRANT_API_KEY`), or self-hosted on
Compute Engine / GKE. **Qdrant must not be publicly reachable** — put it on a
private network with the API key set regardless.

### 5. Migrations

Run as a one-off Cloud Run job rather than at container start, so a rolling
deploy cannot run two migrations concurrently:

```bash
gcloud run jobs create gs-migrate \
  --image gcr.io/$PROJECT/gs-navigator \
  --region $REGION \
  --command npx --args "prisma,migrate,deploy" \
  --set-secrets "DATABASE_URL=gs-database-url:latest" \
  --set-cloudsql-instances $PROJECT:$REGION:gs-navigator-db

gcloud run jobs execute gs-migrate --region $REGION --wait
```

---

## Scheduled re-crawling

Content changes; the index should follow. A weekly crawl is usually right for
a site of this size.

**Cloud Scheduler → Cloud Run job:**

```bash
gcloud run jobs create gs-ingest \
  --image gcr.io/$PROJECT/gs-navigator \
  --region $REGION \
  --command npx --args "tsx,scripts/ingest.ts" \
  --task-timeout 3600 \
  --set-secrets "DATABASE_URL=…,EMBEDDING_API_KEY=…" \
  --set-env-vars "QDRANT_URL=…"

gcloud scheduler jobs create http gs-weekly-crawl \
  --schedule "0 3 * * 1" \
  --time-zone "America/Los_Angeles" \
  --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/gs-ingest:run" \
  --http-method POST --oauth-service-account-email "…"
```

Re-crawling is cheap: unchanged pages are detected by content hash and skipped
without re-embedding. Only changed content costs anything.

### Background worker (optional)

With `REDIS_URL` set, ingestion triggered from the admin dashboard goes to a
BullMQ queue. Deploy a second service running `npm run ingest:worker`, scaled
to exactly one instance. Without Redis, jobs run in the web process — fine for
a small site, but a long crawl can be interrupted by an instance recycling.

### Retention

`purgeExpiredSessions()` deletes conversations past `CHAT_RETENTION_DAYS`.
Schedule it daily — it is not automatic:

```bash
npx tsx -e "import('./src/lib/session').then(m => m.purgeExpiredSessions())"
```

---

## Docker Compose (single host)

For a small deployment, add the app to the existing `docker-compose.yml`:

```yaml
  app:
    build: .
    ports: ['3000:3000']
    env_file: .env
    environment:
      DATABASE_URL: postgresql://gs:gs@postgres:5432/goldensierra?schema=public
      QDRANT_URL: http://qdrant:6333
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres: { condition: service_healthy }
      qdrant: { condition: service_started }

  worker:
    build: .
    command: npm run ingest:worker
    env_file: .env
    environment:
      DATABASE_URL: postgresql://gs:gs@postgres:5432/goldensierra?schema=public
      QDRANT_URL: http://qdrant:6333
      REDIS_URL: redis://redis:6379
    depends_on: [postgres, redis]
```

Note the compose file maps PostgreSQL to host port **5433** to avoid colliding
with a local installation. Inside the network it is still 5432.

Put a reverse proxy (Caddy, nginx) in front for TLS. If you use nginx, disable
response buffering on `/api/chat` or streaming will arrive all at once:

```nginx
location /api/chat {
    proxy_pass http://app:3000;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

---

## Operations

### Health checks

`GET /api/programs?limit=1` is a good liveness probe: it exercises the app and
the database without touching a paid API.

`npm run setup` prints a full dependency report — database, Qdrant, models,
queue, auth secret, and index consistency — with the fix for anything broken.

### Monitoring

Logs are structured JSON with secrets redacted, so they ingest cleanly into
Cloud Logging. Worth alerting on:

| Signal | Why |
|---|---|
| `grounded: false` rate rising | Retrieval is degrading or content is missing |
| Grounding-check warnings | The model is producing unsupported claims |
| `IngestionJob.status = FAILED` | Crawl broken; the index is going stale |
| `missingVectors > 0` | Indexed content is not searchable |
| Rising p95 latency | Model or vector store under pressure |

The admin dashboard surfaces all of these.

### After changing the embedding model

1. Set the new `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`.
2. Use a **new** `QDRANT_COLLECTION` name, or delete the old collection.
3. `npm run vector:init && npm run ingest -- --reindex`.

Startup refuses to run against a dimension-mismatched collection rather than
silently corrupting search, so a forgotten step fails loudly.

### Backups

PostgreSQL is the system of record — back it up normally. Qdrant can be
rebuilt from PostgreSQL at any time with `npm run ingest -- --reindex`, so it
needs no separate backup strategy.

---

## Security checklist

- [ ] `AUTH_SECRET` is ≥ 32 random characters and unique to this deployment
- [ ] All secrets come from a secret manager, not `.env` in the image
- [ ] Qdrant is not publicly reachable, and `QDRANT_API_KEY` is set
- [ ] PostgreSQL is on a private network
- [ ] TLS terminates at the proxy; `APP_URL` uses `https://`
- [ ] `CRAWL_ALLOWED_HOSTS` lists only hosts you are authorized to index
- [ ] Admin accounts use the least role that works (`VIEWER` / `EDITOR` / `ADMIN`)
- [ ] `CHAT_RATE_LIMIT_PER_MIN` suits expected traffic; Redis is configured if
      running more than one instance, or limits apply per-instance
- [ ] `CHAT_RETENTION_DAYS` matches the agency's retention policy, and the
      purge is scheduled
- [ ] Admin dashboard reachable only from trusted networks, if policy requires
