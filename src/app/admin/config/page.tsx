import { AdminRole } from '@prisma/client';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { recommendedChunking } from '@/lib/ingest/chunk';
import { RESPONSE_STYLE } from '@/lib/ai/prompts';
import { Alert, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { ConfigForm } from '@/components/admin/ConfigForm';

export const dynamic = 'force-dynamic';

/**
 * AI configuration.
 *
 * Deliberately split in two: retrieval and generation parameters are tunable
 * at runtime, while provider endpoints, model names and API keys are not.
 * Credentials must not be readable or writable through an HTTP endpoint, so
 * changing a model means changing the environment and redeploying.
 */
export default async function ConfigPage() {
  const session = await requireAdmin(AdminRole.VIEWER);
  const canEdit = session.role === AdminRole.ADMIN;

  const overrides = await prisma.systemConfig.findMany();
  const overrideMap = Object.fromEntries(overrides.map((o) => [o.key, o.value]));

  const effective = {
    RETRIEVAL_TOP_K: Number(overrideMap.RETRIEVAL_TOP_K ?? env.RETRIEVAL_TOP_K),
    RETRIEVAL_FINAL_K: Number(overrideMap.RETRIEVAL_FINAL_K ?? env.RETRIEVAL_FINAL_K),
    RETRIEVAL_MIN_SCORE: Number(overrideMap.RETRIEVAL_MIN_SCORE ?? env.RETRIEVAL_MIN_SCORE),
    HYBRID_KEYWORD_WEIGHT: Number(overrideMap.HYBRID_KEYWORD_WEIGHT ?? env.HYBRID_KEYWORD_WEIGHT),
    CHUNK_SIZE: Number(overrideMap.CHUNK_SIZE ?? env.CHUNK_SIZE),
    CHUNK_OVERLAP: Number(overrideMap.CHUNK_OVERLAP ?? env.CHUNK_OVERLAP),
    LLM_TEMPERATURE: Number(overrideMap.LLM_TEMPERATURE ?? env.LLM_TEMPERATURE),
    LLM_MAX_TOKENS: Number(overrideMap.LLM_MAX_TOKENS ?? env.LLM_MAX_TOKENS),
    RERANK_ENABLED: Boolean(overrideMap.RERANK_ENABLED ?? env.RERANK_ENABLED),
  };

  const advice = recommendedChunking(env.EMBEDDING_MODEL);
  const chunkingMatchesAdvice =
    effective.CHUNK_SIZE === advice.chunkSize && effective.CHUNK_OVERLAP === advice.chunkOverlap;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">AI configuration</h1>
        <p className="text-sm text-muted">
          Retrieval and generation tuning. Provider credentials stay in the environment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Models and endpoints</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Read-only. Change these in the environment and redeploy — API keys are never served
            over HTTP, and a model change requires a re-index.
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row term="LLM provider" value={env.LLM_PROVIDER} />
            <Row term="LLM model" value={env.LLM_MODEL} />
            <Row term="LLM endpoint" value={env.LLM_BASE_URL} />
            <Row term="LLM key configured" value={env.LLM_API_KEY ? 'yes' : 'no'} />
            <Row term="Embedding model" value={env.EMBEDDING_MODEL} />
            <Row term="Embedding dimensions" value={String(env.EMBEDDING_DIMENSIONS)} />
            <Row term="Embedding endpoint" value={env.EMBEDDING_BASE_URL} />
            <Row term="Reranker" value={env.RERANK_MODEL || 'LLM / heuristic fallback'} />
            <Row term="Vector collection" value={env.QDRANT_COLLECTION} />
            <Row term="Authorized crawl hosts" value={env.CRAWL_ALLOWED_HOSTS.join(', ')} />
          </dl>
        </CardContent>
      </Card>

      {!chunkingMatchesAdvice && (
        <Alert tone="info" title={`Suggested chunking for ${env.EMBEDDING_MODEL}`}>
          {advice.rationale} Recommended: size {advice.chunkSize}, overlap {advice.chunkOverlap}.
          Currently {effective.CHUNK_SIZE} / {effective.CHUNK_OVERLAP}. Measure with{' '}
          <code className="font-mono">npm run eval</code> before changing — chunk size changes only
          take effect after a re-index.
        </Alert>
      )}

      <ConfigForm initial={effective} canEdit={canEdit} />

      <Card>
        <CardHeader>
          <CardTitle>Response template</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Defined in <code className="font-mono">src/lib/ai/prompts.ts</code>. Edit{' '}
            <code className="font-mono">RESPONSE_STYLE</code> there to retune tone and length
            against reference conversations.
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row term="Target maximum length" value={`${RESPONSE_STYLE.maxWords} words`} />
            <Row term="Maximum recommendations" value={String(RESPONSE_STYLE.maxRecommendations)} />
            <Row term="Follow-up suggestions" value={String(RESPONSE_STYLE.followUpCount)} />
            <Row term="Reading level" value={RESPONSE_STYLE.readingLevel} />
            <Row term="Tone" value={RESPONSE_STYLE.tone} />
          </dl>

          <Alert tone="warning" className="mt-4">
            The reference Workforce Navigator prototype is behind an access code and was not
            observed, so this template is a documented starting point rather than a verified
            replication. Load real transcripts as eval cases and tune against them.
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-muted">{term}</dt>
      <dd className="min-w-0 break-all text-right font-medium">{value}</dd>
    </div>
  );
}
