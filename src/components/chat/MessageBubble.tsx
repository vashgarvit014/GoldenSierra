'use client';

import { useState } from 'react';
import { AlertTriangle, BookOpen, Check, ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Markdown } from './Markdown';
import { RecommendationCard } from './RecommendationCard';
import { Badge } from '@/components/ui';
import { cn, formatDate, hostOf } from '@/lib/utils';
import type { ChatTurn } from '@/types/chat';

type Props = {
  turn: ChatTurn;
  streaming?: boolean;
  onFeedback?: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => void;
  feedbackGiven?: 'HELPFUL' | 'NOT_HELPFUL' | null;
};

export function MessageBubble({ turn, streaming, onFeedback, feedbackGiven }: Props) {
  const [showSources, setShowSources] = useState(false);

  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%] rounded-card rounded-br-control bg-ink px-4 py-2.5 text-[15px] leading-relaxed text-ink-foreground">
          {turn.content}
        </div>
      </div>
    );
  }

  const payload = turn.payload;
  const citations = payload?.citations ?? [];
  const recommendations = payload?.recommendations ?? [];
  const conflicts = payload?.conflicts ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="rise-in max-w-full rounded-card rounded-bl-control border border-border bg-surface px-4 py-3 text-[15px]">
        <Markdown
          content={turn.content}
          citations={citations}
          onCitationClick={() => setShowSources(true)}
        />
        {streaming && (
          <span className="ml-1 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
        )}
      </div>

      {/* An answer the pipeline could not ground is labelled, not hidden. */}
      {!streaming && payload && !payload.grounded && (
        <div className="flex items-start gap-2 rounded-panel border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-strong">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            This answer is not backed by indexed Golden Sierra sources. Please confirm anything
            important by calling (916) 746-7722.
          </span>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="rounded-panel border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-strong">
          <p className="font-semibold mb-1">Sources disagree</p>
          {conflicts.map((conflict, i) => (
            <p key={i}>
              The published pages give different values for {conflict.topic}. Staff can confirm
              which is current.
            </p>
          ))}
        </div>
      )}

      {recommendations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {recommendations.length === 1 ? 'Service that may fit' : 'Services that may fit'}
          </p>
          {recommendations.map((recommendation) => (
            <RecommendationCard
              key={recommendation.programId ?? recommendation.name}
              recommendation={recommendation}
            />
          ))}
        </div>
      )}

      {!streaming && citations.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            aria-expanded={showSources}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {showSources ? 'Hide sources' : `${citations.length} source${citations.length === 1 ? '' : 's'}`}
          </button>

          {showSources && (
            <ul className="mt-2 space-y-1.5">
              {citations.map((citation) => (
                <li key={citation.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-control bg-accent-soft px-1 text-[10px] font-bold text-accent">
                    {citation.id}
                  </span>
                  <span className="min-w-0">
                    {citation.url ? (
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link inline-flex items-center gap-1"
                      >
                        {citation.title}
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <span>{citation.title}</span>
                    )}
                    <span className="block text-muted-foreground">
                      {hostOf(citation.url)}
                      {citation.lastVerified && ` · checked ${formatDate(citation.lastVerified)}`}
                      {citation.documentType === 'PDF' && ' · PDF'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!streaming && onFeedback && (
        <div className="flex items-center gap-2">
          {feedbackGiven ? (
            <Badge tone="success">
              <Check className="h-3 w-3" aria-hidden="true" />
              Thanks for the feedback
            </Badge>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">Was this helpful?</span>
              <button
                type="button"
                onClick={() => onFeedback(turn.id, 'HELPFUL')}
                aria-label="This answer was helpful"
                className="rounded-control p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onFeedback(turn.id, 'NOT_HELPFUL')}
                aria-label="This answer was not helpful"
                className="rounded-control p-1 text-muted-foreground hover:bg-muted hover:text-destructive-strong"
              >
                <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TypingIndicator({ label = 'Looking through Golden Sierra resources' }: { label?: string }) {
  return (
    <div
      className="flex w-fit items-center gap-2.5 rounded-card rounded-bl-control border border-border bg-surface px-4 py-3"
      role="status"
      aria-live="polite"
    >
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn('typing-dot h-1.5 w-1.5 rounded-full bg-accent')}
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      <span className="text-xs text-muted-foreground">{label}…</span>
    </div>
  );
}
