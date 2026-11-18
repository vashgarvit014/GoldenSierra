# Ingestion worker (BullMQ consumer) for container hosts such as Railway.
# Build context is the repository root:  docker build -f deploy/worker/Dockerfile .
# Vercel cannot run crawls (60 s function limit); the web app pushes jobs to Redis and this
# process runs them to completion. Embeddings come from EMBEDDING_BASE_URL (deploy/embeddings).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --ignore-scripts skips the local-model and browser downloads this worker never uses.
RUN npm ci --ignore-scripts --no-audit --no-fund && npx prisma generate
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
CMD ["npx", "tsx", "scripts/worker.ts"]
