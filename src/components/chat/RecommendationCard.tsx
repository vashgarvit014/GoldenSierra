'use client';

import { useState } from 'react';
import { ChevronDown, ExternalLink, Info, Phone } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Recommendation } from '@/types/chat';

/**
 * A matched service, rendered as a card beneath the answer.
 *
 * Note what this card does NOT show: a match percentage. There is no
 * validated scoring model behind the ranking, and a number would read as a
 * measurement rather than an ordering. "Why this fits" says the same thing
 * honestly.
 */
export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    recommendation.eligibility.length > 0 ||
    Boolean(recommendation.nextSteps) ||
    recommendation.exclusions.length > 0;

  return (
    <div className="bg-surface border border-default rounded-xl overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="font-semibold text-sm leading-snug">{recommendation.name}</h4>
            {recommendation.category && (
              <p className="text-xs text-muted mt-0.5">{recommendation.category}</p>
            )}
          </div>
          {recommendation.requiresVerification && (
            <Badge tone="warning" className="shrink-0">
              <Info className="h-3 w-3" aria-hidden="true" />
              Staff confirm
            </Badge>
          )}
        </div>

        <p className="text-sm mt-2 leading-relaxed">{recommendation.shortDescription}</p>

        <p className="text-xs text-muted mt-2">
          <span className="font-medium text-[var(--text)]">Why this fits: </span>
          {recommendation.whyRelevant}
        </p>

        {recommendation.exclusions.length > 0 && (
          <p className="text-xs mt-2 text-gold-700">
            <span className="font-medium">Worth checking: </span>
            {recommendation.exclusions.join('; ')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 mt-3">
          {recommendation.officialUrl && (
            <a
              href={recommendation.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-sierra-700 hover:underline dark:text-sierra-300"
            >
              Official page
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
          {recommendation.contactPhone && (
            <a
              href={`tel:${recommendation.contactPhone.replace(/\D/g, '')}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-sierra-700 hover:underline dark:text-sierra-300"
            >
              <Phone className="h-3 w-3" aria-hidden="true" />
              {recommendation.contactPhone}
            </a>
          )}
          {hasDetail && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-[var(--text)] ml-auto"
            >
              {expanded ? 'Less' : 'Details'}
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      </div>

      {expanded && hasDetail && (
        <div className="border-t border-default bg-surface-muted px-4 py-3 space-y-3">
          {recommendation.eligibility.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-1.5">Published requirements</p>
              <ul className="space-y-1.5">
                {recommendation.eligibility.map((rule, i) => (
                  <li key={i} className="text-xs text-muted flex gap-2">
                    <span aria-hidden="true" className="text-sierra-500">•</span>
                    <span>
                      {rule.description}
                      {rule.sourceUrl && (
                        <>
                          {' '}
                          <a
                            href={rule.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sierra-600 hover:underline dark:text-sierra-300"
                          >
                            (source)
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {recommendation.nextSteps && (
            <div>
              <p className="text-xs font-semibold mb-1">How to start</p>
              <p className="text-xs text-muted leading-relaxed">{recommendation.nextSteps}</p>
            </div>
          )}

          {recommendation.requiresVerification && (
            <p className="text-xs text-muted italic">
              Golden Sierra staff decide who is eligible. This is a possible match, not a decision.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
