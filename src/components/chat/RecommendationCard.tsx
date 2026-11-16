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
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-base font-bold leading-snug text-accent">{recommendation.name}</h4>
            {recommendation.category && (
              <p className="mt-0.5 text-xs text-muted-foreground">{recommendation.category}</p>
            )}
          </div>
          {recommendation.requiresVerification && (
            <Badge tone="accent" className="shrink-0">
              <Info className="h-3 w-3" aria-hidden="true" />
              Staff confirm
            </Badge>
          )}
        </div>

        <p className="mt-2 text-sm leading-relaxed">{recommendation.shortDescription}</p>

        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Why this fits: </span>
          {recommendation.whyRelevant}
        </p>

        {recommendation.exclusions.length > 0 && (
          <p className="mt-2 text-xs text-warning-strong">
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
              className="inline-flex items-center gap-1 text-xs font-semibold link"
            >
              Official page
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
          {recommendation.contactPhone && (
            <a
              href={`tel:${recommendation.contactPhone.replace(/\D/g, '')}`}
              className="inline-flex items-center gap-1 text-xs font-semibold link"
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
              className="inline-flex items-center gap-1 ml-auto text-xs font-semibold text-muted-foreground hover:text-foreground"
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
        <div className="space-y-3 border-t border-border bg-muted px-4 py-3">
          {recommendation.eligibility.length > 0 && (
            <div>
              <p className="text-xs font-bold mb-1.5">Published requirements</p>
              <ul className="space-y-1.5">
                {recommendation.eligibility.map((rule, i) => (
                  <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                    <span aria-hidden="true" className="text-accent">•</span>
                    <span>
                      {rule.description}
                      {rule.sourceUrl && (
                        <>
                          {' '}
                          <a
                            href={rule.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link"
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
              <p className="text-xs font-bold mb-1">How to start</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{recommendation.nextSteps}</p>
            </div>
          )}

          {recommendation.requiresVerification && (
            <p className="text-xs italic text-muted-foreground">
              Golden Sierra staff decide who is eligible. This is a possible match, not a decision.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
