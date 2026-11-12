/** Creates the Qdrant collection and its payload indexes. Safe to re-run. */
import 'dotenv/config';
import { ensureCollection, collectionStats, qdrantHealthy } from '../src/lib/vector/qdrant';
import { env } from '../src/lib/env';

async function main() {
  console.log(`Qdrant: ${env.QDRANT_URL}`);
  console.log(`Collection: ${env.QDRANT_COLLECTION}`);
  console.log(`Embedding model: ${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS}d)\n`);

  if (!(await qdrantHealthy())) {
    console.error('Cannot reach Qdrant. Is it running?  docker compose up -d qdrant');
    process.exit(1);
  }

  const { created, dimensions } = await ensureCollection();
  console.log(created ? `Created collection (${dimensions}d).` : 'Collection already exists.');

  const stats = await collectionStats();
  console.log(`Vectors: ${stats.vectorCount}  Indexed: ${stats.indexedCount}  Status: ${stats.status}`);
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
