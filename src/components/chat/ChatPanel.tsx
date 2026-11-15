'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, ListChecks, MapPin, RefreshCw, Sparkles } from 'lucide-react';
import { MessageBubble, TypingIndicator } from './MessageBubble';
import { RecommendationCard } from './RecommendationCard';
import { Alert, Badge, Button, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Recommendation } from '@/types/chat';
import {
  MODE_OPENERS,
  type CounselorMessage,
  type CounselorTurn,
  type ProgramMatch,
  type SessionMode,
} from '@/types/counselor';

/**
 * The Golden Sierra assistant.
 *
 * Same surface as before — this is the existing panel, not a new one. What
 * changed is the behaviour behind it: instead of answering immediately from
 * retrieval, it now runs the counselor turn engine, which understands the
 * situation first, asks one useful question at a time, and consolidates
 * recommendations once it knows enough.
 *
 * Everything visual stays in the project's design system: sierra/gold tokens,
 * the existing bubbles, cards and primitives. No sidebar — what the assistant
 * has understood appears as a compact, collapsible strip under the header.
 */

const TOKEN_KEY = 'gs_nav_session';

export function ChatPanel() {
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [messages, setMessages] = useState<CounselorMessage[]>([]);
  const [turn, setTurn] = useState<CounselorTurn | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, 'HELPFUL' | 'NOT_HELPFUL'>>({});

  const session = useRef<{ id: string; token: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Resume an in-progress conversation on reload.
  useEffect(() => {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    void (async () => {
      try {
        const parsed = JSON.parse(raw) as { id: string; token: string };
        const res = await fetch(`/api/session?token=${encodeURIComponent(parsed.token)}`);
        if (!res.ok) throw new Error('expired');
        const data = (await res.json()) as { mode: SessionMode; messages: CounselorMessage[] };
        session.current = parsed;
        setMode(data.mode);
        setMessages(data.messages);
        const last = [...data.messages].reverse().find((m) => m.turn);
        if (last?.turn) setTurn(last.turn);
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const begin = useCallback(async (chosen: SessionMode) => {
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: chosen }),
      });
      if (!res.ok) throw new Error('Could not start a conversation');
      const data = (await res.json()) as { sessionId: string; sessionToken: string };
      session.current = { id: data.sessionId, token: data.sessionToken };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session.current));
      setMode(chosen);
      setMessages([]);
      setTurn(null);
    } catch {
      setError('Could not connect. Please refresh, or call (916) 746-7722.');
    }
  }, []);

  const send = useCallback(
    async (text: string, forceResults = false) => {
      const body = text.trim();
      if ((!body && !forceResults) || sending || !session.current) return;

      setError(null);
      setInput('');
      setSending(true);
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: 'user', content: body, createdAt: new Date().toISOString() },
      ]);

      try {
        const res = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken: session.current.token, message: body, forceResults }),
        });
        const data = (await res.json()) as { messageId?: string; turn?: CounselorTurn; error?: string };
        if (!res.ok || !data.turn) throw new Error(data.error ?? 'The assistant could not answer that.');

        setTurn(data.turn);
        setMessages((prev) => [
          ...prev,
          {
            id: data.messageId ?? `a-${Date.now()}`,
            role: 'assistant',
            content: data.turn!.message,
            turn: data.turn,
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [sending],
  );

  const rate = useCallback(async (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => {
    const s = session.current;
    if (!s) return;
    setFeedback((prev) => ({ ...prev, [messageId]: rating }));
    await fetch('/api/chat/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, sessionToken: s.token, messageId, rating }),
    }).catch(() => undefined); // best-effort, never blocking
  }, []);

  if (!mode) return <ModeChooser onChoose={begin} error={error} />;

  const opener = MODE_OPENERS[mode];
  const facts = turn?.knownFacts.filter((f) => f.state === 'known') ?? [];
  const quickReplies = turn?.quickReplies ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* ── Header: unchanged layout, plus a compact context toggle ── */}
      <header className="border-b border-default bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight">Workforce Navigator</h1>
            <p className="truncate text-xs text-muted">
              Golden Sierra Job Training Agency · Placer, El Dorado &amp; Alpine counties
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {turn?.context.county && (
              <span className="hidden items-center gap-1 rounded-full bg-sierra-50 px-2 py-1 text-xs text-sierra-800 sm:inline-flex dark:bg-sierra-900 dark:text-sierra-100">
                <MapPin className="h-3 w-3" aria-hidden="true" />
                {turn.context.county}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                sessionStorage.removeItem(TOKEN_KEY);
                setMode(null);
                setMessages([]);
                setTurn(null);
              }}
              disabled={sending}
              title="Start a new conversation"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">New chat</span>
            </Button>
          </div>
        </div>

        {/* Compact summary of what has been understood — inline, not a sidebar. */}
        {facts.length > 0 && (
          <div className="border-t border-default px-4 py-2">
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              aria-expanded={showContext}
              className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-[var(--text)]"
            >
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
              What I&apos;ve noted ({facts.length})
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', showContext && 'rotate-180')}
                aria-hidden="true"
              />
            </button>

            {showContext && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-noted>
                {facts.map((f) => (
                  <Badge key={f.key} tone="success" title={f.dimension}>
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {f.label}
                  </Badge>
                ))}
                {turn?.narrowing.candidates != null && turn.narrowing.total != null && (
                  <Badge tone="neutral" title={turn.narrowing.explanation}>
                    {turn.narrowing.candidates} of {turn.narrowing.total} services match
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* ── Transcript ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-5"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 && (
            <div className="rounded-2xl rounded-bl-md border border-default bg-surface px-4 py-3">
              <div className="flex items-start gap-2.5">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-gold-500" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold">{opener.title}</p>
                  <p className="mt-1 text-sm leading-relaxed">{opener.body}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {opener.replies.map((r) => (
                  <QuickReply key={r} label={r} onClick={() => void send(r)} disabled={sending} />
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <MessageBubble
                key={m.id}
                turn={{ id: m.id, role: 'user', content: m.content, createdAt: m.createdAt }}
              />
            ) : (
              <AssistantTurn
                key={m.id}
                message={m}
                isLatest={i === messages.length - 1}
                sending={sending}
                feedbackGiven={feedback[m.id] ?? null}
                onReply={(v) => void send(v)}
                onFeedback={rate}
              />
            ),
          )}

          {sending && <TypingIndicator label="Thinking that through" />}

          {error && (
            <Alert tone="danger" title="Something went wrong">
              {error}
            </Alert>
          )}
        </div>
      </div>

      {/* ── Composer ── */}
      <div className="border-t border-default bg-surface px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {/* Contextual quick replies for the question just asked. */}
          {!sending && quickReplies.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {quickReplies.map((r) => (
                <QuickReply key={r.value} label={r.label} onClick={() => void send(r.value)} />
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2"
          >
            <label htmlFor="chat-input" className="sr-only">
              Type your answer
            </label>
            <Textarea
              id="chat-input"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Type your answer…"
              disabled={sending}
              maxLength={2000}
              className="min-h-10 py-2.5"
            />
            {turn?.canShowResults && turn.stage !== 'results' && (
              <Button
                type="button"
                variant="gold"
                disabled={sending}
                onClick={() => void send('Show me what fits', true)}
                className="shrink-0"
                title="Skip ahead to recommendations"
              >
                See recommendations
              </Button>
            )}
            <Button
              type="submit"
              size="icon"
              disabled={sending || !input.trim()}
              aria-label="Send message"
              className="shrink-0"
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>

          <p className="mt-2 text-center text-[11px] leading-snug text-muted">
            This assistant shares published information and cannot decide eligibility. Golden Sierra
            staff confirm who qualifies · (916) 746-7722
          </p>
        </div>
      </div>
    </div>
  );
}

/** Styled with the project's own tokens — no reference palette. */
function QuickReply({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-full border border-default bg-surface-muted px-3 py-1.5 text-xs',
        'hover:border-sierra-300 hover:bg-sierra-50 disabled:opacity-50',
        'dark:hover:bg-sierra-900',
      )}
    >
      {label}
    </button>
  );
}

function ModeChooser({
  onChoose,
  error,
}: {
  onChoose: (m: SessionMode) => void;
  error: string | null;
}) {
  return (
    <div className="flex h-full items-center justify-center px-5">
      <div className="w-full max-w-lg text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-sierra-50 text-sierra-700 dark:bg-sierra-900 dark:text-sierra-200">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Let&apos;s find the right support</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
          A few short questions, then services that fit the situation — with the sources behind them.
        </p>

        {error && (
          <Alert tone="danger" className="mt-4 text-left">
            {error}
          </Alert>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            onClick={() => onChoose('self')}
            className="rounded-xl border border-default bg-surface p-4 text-left transition hover:border-sierra-300 hover:shadow-sm"
          >
            <span className="block text-sm font-semibold">I&apos;m looking for myself</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              Work, training, or help paying for it.
            </span>
          </button>
          <button
            onClick={() => onChoose('helper')}
            className="rounded-xl border border-default bg-surface p-4 text-left transition hover:border-sierra-300 hover:shadow-sm"
          >
            <span className="block text-sm font-semibold">I&apos;m helping someone</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              A client, a student, or a family member.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  isLatest,
  sending,
  feedbackGiven,
  onReply,
  onFeedback,
}: {
  message: CounselorMessage;
  isLatest: boolean;
  sending: boolean;
  feedbackGiven: 'HELPFUL' | 'NOT_HELPFUL' | null;
  onReply: (value: string) => void;
  onFeedback: (id: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => void;
}) {
  const t = message.turn;
  const isResults = t?.stage === 'results';

  return (
    <div className="flex flex-col gap-3">
      <MessageBubble
        turn={{
          id: message.id,
          role: 'assistant',
          content: message.content,
          createdAt: message.createdAt,
          payload: t
            ? {
                intent: 'general_info',
                confidence: 1,
                recommendations: [],
                citations: t.sources.map((s) => ({
                  id: s.id,
                  title: s.title,
                  url: s.url,
                  lastVerified: null,
                  documentType: 'WEB_PAGE',
                })),
                sources: [],
                followUpSuggestions: [],
                conflicts: [],
                grounded: isResults ? t.grounded : true,
                profile: {},
                clarifyingQuestion: null,
                latencyMs: 0,
              }
            : undefined,
        }}
        onFeedback={isResults ? onFeedback : undefined}
        feedbackGiven={feedbackGiven}
      />

      {/* An interpretation the assistant is relying on — correctable, never silent. */}
      {t?.assumption && (
        <div className="rounded-lg border border-gold-300 bg-gold-100 px-3 py-2.5 text-xs text-gold-700">
          <p className="font-semibold">Assuming from what you&apos;ve told me</p>
          <p className="mt-1 leading-relaxed">{t.assumption.text}</p>
          {isLatest && (
            <button
              type="button"
              className="mt-1.5 font-semibold underline underline-offset-2"
              onClick={() => onReply("That's not quite right — let me correct that")}
              disabled={sending}
            >
              That&apos;s not right
            </button>
          )}
        </div>
      )}

      {isResults && t.recommendations.length > 0 && (
        // Only the newest set is spelled out. Earlier ones were drawn from
        // less information, so repeating them stacks stale cards up the
        // transcript and contradicts the current count.
        isLatest ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t.recommendations.length === 1 ? 'Service that may fit' : 'Services that may fit'}
            </p>
            {t.recommendations.map((m) => (
              <RecommendationCard key={m.id} recommendation={toRecommendation(m)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {t.recommendations.length} service{t.recommendations.length === 1 ? '' : 's'} suggested
            here — updated further down as we learned more.
          </p>
        )
      )}
    </div>
  );
}

/** Adapts a counselor match to the existing card's shape, so the component
 *  used everywhere else renders these too. */
function toRecommendation(m: ProgramMatch): Recommendation {
  const stateReason: Record<string, string> = {
    eligible: 'Matches what you’ve told me',
    potential: 'Looks like a possible fit',
    needs_verification: 'Worth checking with staff',
  };
  return {
    programId: m.id,
    slug: m.slug,
    name: m.name,
    shortDescription: m.shortDescription,
    whyRelevant: m.reasons[0] ?? stateReason[m.state] ?? 'Relevant to what you described',
    eligibility: m.reasons.slice(1).map((r) => ({ description: r, sourceUrl: null, verified: true })),
    nextSteps: m.nextSteps,
    officialUrl: m.officialUrl,
    contactPhone: m.contactPhone,
    requiresVerification: m.state !== 'eligible',
    exclusions: m.openQuestions,
    category: m.category,
  };
}
