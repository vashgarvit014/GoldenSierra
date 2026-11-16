/**
 * One-off: tag vectors written before `sourceId` existed in the payload.
 * Payload-only and idempotent — no vector, id or chunk text changes.
 *   npx tsx scripts/backfill-source-ids.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { ensureCollection } from '../src/lib/vector/qdrant';
import { auditIndex, backfillSourceIds } from '../src/lib/ingest/pipeline';

(async () => {
  await ensureCollection(); // creates the sourceId payload index if missing
  const before = await auditIndex();
  const result = await backfillSourceIds();
  const after = await auditIndex();
  console.log(JSON.stringify({ result, before, after }));
  await prisma.$disconnect();
})();
