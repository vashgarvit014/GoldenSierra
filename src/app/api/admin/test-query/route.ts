import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { requireAdmin } from '@/lib/auth';
import { generateAnswer } from '@/lib/rag/generate';
import type { ChatTurn, UserProfile } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s is the ceiling on Vercel's Hobby plan, and a route declaring more fails
// the deployment outright. Long-running ingestion does not belong in a
// serverless request anyway — run `npm run ingest` from the CLI or a worker.
export const maxDuration = 60;

const BodySchema = z.object({
  message: z.string().min(1).max(2000),
  profile: z
    .object({
      county: z.enum(['Placer', 'El Dorado', 'Alpine']).optional(),
      employmentStatus: z
        .enum(['unemployed', 'employed', 'underemployed', 'laid_off', 'student', 'unknown'])
        .optional(),
      audience: z.enum(['job_seeker', 'employer']).optional(),
      isVeteran: z.boolean().optional(),
      careerInterests: z.array(z.string().max(60)).max(5).optional(),
    })
    .optional()
    .default({}),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(10)
    .optional()
    .default([]),
});

/**
 * POST /api/admin/test-query
 *
 * The admin test console. Runs the full pipeline and returns everything the
 * answer was built from — retrieved passages with scores, matched programs,
 * detected conflicts, and any grounding violations — so a reviewer can see
 * *why* an answer came out the way it did, not just what it said.
 *
 * Nothing here is written to a chat session; test queries do not pollute
 * usage analytics or conversation history.
 */
export const POST = withErrorHandling(async (request: Request) => {
  await requireAdmin(AdminRole.VIEWER);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = BodySchema.parse(json);

  const history: ChatTurn[] = body.history.map((turn, i) => ({
    id: `test-${i}`,
    role: turn.role,
    content: turn.content,
    createdAt: new Date().toISOString(),
  }));

  const started = Date.now();
  const result = await generateAnswer({
    message: body.message,
    history,
    profile: body.profile as UserProfile,
  });

  return NextResponse.json({
    answer: result.answer,
    analysis: {
      intent: result.analysis.intent,
      confidence: result.analysis.confidence,
      rewrittenQuery: result.analysis.rewrittenQuery,
      keywords: result.analysis.keywords,
      extractedProfile: result.analysis.profileUpdates,
      missingInfo: result.analysis.missingInfo,
      isMultiPart: result.analysis.isMultiPart,
      subQuestions: result.analysis.subQuestions,
    },
    grounding: result.grounding,
    recommendations: result.payload.recommendations,
    citations: result.payload.citations,
    conflicts: result.payload.conflicts,
    followUpSuggestions: result.payload.followUpSuggestions,
    retrievedSources: result.payload.sources.map((s) => ({
      title: s.title,
      url: s.url,
      headingPath: s.headingPath,
      category: s.category,
      score: Number(s.score.toFixed(4)),
      rerankScore: s.rerankScore != null ? Number(s.rerankScore.toFixed(4)) : null,
      lastVerified: s.lastVerified,
      snippet: s.snippet.slice(0, 400),
    })),
    usage: result.usage,
    latencyMs: Date.now() - started,
  });
});
