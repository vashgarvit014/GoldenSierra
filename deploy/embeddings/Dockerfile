FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
# Bake the model into the image so a cold start needs no download.
RUN node -e "import('@huggingface/transformers').then(async ({pipeline, env}) => { env.cacheDir='/app/.cache'; await pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:'q8'}); })"
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
