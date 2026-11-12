import { NextResponse } from 'next/server';
import { AdminRole, DocumentStatus, FeedbackRating, JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withErrorHandling } from '@/lib/errors';
import { requireAdmin } from '@/lib/auth';
import { collectionStats, qdrantHealthy } from '@/lib/vector/qdrant';
import { auditIndex } from '@/lib/ingest/pipeline';
import { env, hasLlm, hasRedis } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/analytics — dashboard overview. */
export const GET = withErrorHandling(async () => {
  await requireAdmin(AdminRole.VIEWER);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalDocuments,
    indexedDocuments,
    failedDocuments,
    archivedDocuments,
    totalChunks,
    totalSources,
    recentJobs,
    failedJobs,
    totalSessions,
    recentSessions,
    totalMessages,
    helpful,
    notHelpful,
    ungroundedCount,
    topIntents,
    latency,
    vector,
    vectorUp,
    index,
  ] = await Promise.all([
    prisma.document.count(),
    prisma.document.count({ where: { status: DocumentStatus.INDEXED } }),
    prisma.document.count({ where: { status: DocumentStatus.FAILED } }),
    prisma.document.count({ where: { status: DocumentStatus.ARCHIVED } }),
    prisma.documentChunk.count(),
    prisma.knowledgeSource.count(),
    prisma.ingestionJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { source: { select: { name: true } } },
    }),
    prisma.ingestionJob.count({ where: { status: JobStatus.FAILED, createdAt: { gte: since } } }),
    prisma.chatSession.count(),
    prisma.chatSession.count({ where: { startedAt: { gte: since } } }),
    prisma.chatMessage.count(),
    prisma.chatFeedback.count({ where: { rating: FeedbackRating.HELPFUL } }),
    prisma.chatFeedback.count({ where: { rating: FeedbackRating.NOT_HELPFUL } }),
    prisma.retrievalLog.count({ where: { grounded: false, createdAt: { gte: since } } }),
    prisma.retrievalLog.groupBy({
      by: ['intent'],
      _count: { intent: true },
      where: { createdAt: { gte: since } },
      orderBy: { _count: { intent: 'desc' } },
      take: 8,
    }),
    prisma.retrievalLog.aggregate({
      _avg: { totalMs: true, vectorMs: true, rerankMs: true },
      where: { createdAt: { gte: since } },
    }),
    collectionStats(),
    qdrantHealthy(),
    auditIndex(),
  ]);

  const totalFeedback = helpful + notHelpful;

  return NextResponse.json({
    knowledge: {
      totalSources,
      totalDocuments,
      indexedDocuments,
      failedDocuments,
      archivedDocuments,
      totalChunks,
    },
    vector: { ...vector, healthy: vectorUp },
    index,
    ingestion: {
      failedJobsLast30Days: failedJobs,
      recent: recentJobs.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        sourceName: j.source?.name ?? null,
        documentsCreated: j.documentsCreated,
        documentsUpdated: j.documentsUpdated,
        chunksIndexed: j.chunksIndexed,
        errorCount: j.errorCount,
        createdAt: j.createdAt.toISOString(),
        finishedAt: j.finishedAt?.toISOString() ?? null,
      })),
    },
    usage: {
      totalSessions,
      sessionsLast30Days: recentSessions,
      totalMessages,
      ungroundedAnswersLast30Days: ungroundedCount,
      avgLatencyMs: Math.round(latency._avg.totalMs ?? 0),
      avgVectorMs: Math.round(latency._avg.vectorMs ?? 0),
      avgRerankMs: Math.round(latency._avg.rerankMs ?? 0),
      topIntents: topIntents.map((i) => ({ intent: i.intent ?? 'unknown', count: i._count.intent })),
    },
    feedback: {
      helpful,
      notHelpful,
      total: totalFeedback,
      // Reported as null rather than 0% when nobody has rated anything yet.
      helpfulRate: totalFeedback > 0 ? Math.round((helpful / totalFeedback) * 100) : null,
    },
    configuration: {
      llmModel: env.LLM_MODEL,
      llmConfigured: hasLlm(),
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
      queueMode: hasRedis() ? 'redis' : 'in-process',
      retrievalTopK: env.RETRIEVAL_TOP_K,
      retrievalFinalK: env.RETRIEVAL_FINAL_K,
      rerankEnabled: env.RERANK_ENABLED,
    },
  });
});
