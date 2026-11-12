'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, MapPin, RefreshCw, Sparkles } from 'lucide-react';
import { MessageBubble, TypingIndicator } from './MessageBubble';
import { Alert, Button, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  STARTER_QUESTIONS,
  type AssistantPayload,
  type ChatTurn,
  type UserProfile,
} from '@/types/chat';

/**
 * The chat surface.
 *
 * The session token is kept in sessionStorage rather than localStorage: a
 * conversation should not outlive the browser tab by default, and the token
 * is the only credential that can read it back.
 */

const TOKEN_KEY = 'gs_nav_session';

type StreamEvent =
  | ({ type: 'meta' } & Partial<AssistantPayload>)
  | { type: 'token'; value: string }
  | { type: 'done'; messageId: string; answer: string; payload: AssistantPayload }
  | { type: 'error'; error: string };

export function ChatPanel() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingPayload, setStreamingPayload] = useState<Partial<AssistantPayload> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([...STARTER_QUESTIONS]);
  const [profile, setProfile] = useState<UserProfile>({});
  const [feedback, setFeedback] = useState<Record<string, 'HELPFUL' | 'NOT_HELPFUL'>>({});
  const [ready, setReady] = useState(false);

  const sessionRef = useRef<{ id: string; token: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Session bootstrap ──
  const startSession = useCallback(async (fresh = false) => {
    setReady(false);
    setError(null);

    if (fresh) {
      sessionStorage.removeItem(TOKEN_KEY);
      setTurns([]);
      setProfile({});
      setFeedback({});
      setSuggestions([...STARTER_QUESTIONS]);
    }

    const stored = fresh ? null : sessionStorage.getItem(TOKEN_KEY);

    // Try to resume an existing conversation before creating a new one.
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { id: string; token: string };
        const response = await fetch(
          `/api/chat/session/${parsed.id}?token=${encodeURIComponent(parsed.token)}`,
        );
        if (response.ok) {
          const data = (await response.json()) as {
            messages: ChatTurn[];
            profile: UserProfile;
          };
          sessionRef.current = parsed;
          setTurns(data.messages);
          setProfile(data.profile ?? {});
          const last = data.messages.at(-1);
          if (last?.payload?.followUpSuggestions?.length) {
            setSuggestions(last.payload.followUpSuggestions);
          }
          setReady(true);
          return;
        }
      } catch {
        // Fall through and start fresh.
      }
      sessionStorage.removeItem(TOKEN_KEY);
    }

    try {
      const response = await fetch('/api/chat/session', { method: 'POST' });
      if (!response.ok) throw new Error('Could not start a conversation');
      const data = (await response.json()) as {
        sessionId: string;
        sessionToken: string;
        welcome: string;
        starterQuestions: string[];
      };

      sessionRef.current = { id: data.sessionId, token: data.sessionToken };
      sessionStorage.setItem(
        TOKEN_KEY,
        JSON.stringify({ id: data.sessionId, token: data.sessionToken }),
      );
      setWelcome(data.welcome);
      setSuggestions(data.starterQuestions);
      setReady(true);
    } catch {
      setError('Could not connect. Please refresh the page, or call (916) 746-7722.');
    }
  }, []);

  useEffect(() => {
    void startSession();
    return () => abortRef.current?.abort();
  }, [startSession]);

  // Keep the newest content in view as tokens arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, streamingText]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const session = sessionRef.current;
      if (!trimmed || sending || !session) return;

      setError(null);
      setInput('');
      setSending(true);
      setStreamingText('');
      setStreamingPayload(null);
      setWelcome(null);

      const userTurn: ChatTurn = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, userTurn]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, sessionToken: session.token, stream: true }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'The assistant could not answer that request.');
        }
        if (!response.body) throw new Error('No response received.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        // NDJSON: one JSON event per line, so a partial line must be held
        // over until the next chunk completes it.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue; // tolerate a malformed line rather than dropping the stream
            }

            if (event.type === 'meta') {
              setStreamingPayload(event);
              if (event.profile) setProfile(event.profile);
            } else if (event.type === 'token') {
              accumulated += event.value;
              setStreamingText(accumulated);
            } else if (event.type === 'done') {
              setTurns((prev) => [
                ...prev,
                {
                  id: event.messageId,
                  role: 'assistant',
                  // The finalized answer, not the raw stream: citations have
                  // been renumbered and overclaims softened server-side.
                  content: event.answer,
                  payload: event.payload,
                  createdAt: new Date().toISOString(),
                },
              ]);
              setStreamingText('');
              setStreamingPayload(null);
              setProfile(event.payload.profile);
              if (event.payload.followUpSuggestions.length) {
                setSuggestions(event.payload.followUpSuggestions);
              }
            } else if (event.type === 'error') {
              setError(event.error);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : 'Something went wrong. Please try again, or call (916) 746-7722.',
        );
        setStreamingText('');
        setStreamingPayload(null);
      } finally {
        setSending(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [sending],
  );

  const submitFeedback = useCallback(
    async (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => {
      const session = sessionRef.current;
      if (!session) return;
      setFeedback((prev) => ({ ...prev, [messageId]: rating }));
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          sessionToken: session.token,
          messageId,
          rating,
        }),
      }).catch(() => undefined); // feedback is best-effort, never blocking
    },
    [],
  );

  const showSuggestions = !sending && suggestions.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <header className="flex items-center justify-between gap-3 border-b border-default bg-surface px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-tight">Workforce Navigator</h1>
          <p className="text-xs text-muted truncate">
            Golden Sierra Job Training Agency · Placer, El Dorado &amp; Alpine counties
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {profile.county && (
            <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-sierra-50 px-2 py-1 text-xs text-sierra-800 dark:bg-sierra-900 dark:text-sierra-100">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {profile.county}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void startSession(true)}
            disabled={sending}
            title="Start a new conversation"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        </div>
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
          {welcome && turns.length === 0 && (
            <div className="rounded-2xl rounded-bl-md border border-default bg-surface px-4 py-3">
              <div className="flex items-start gap-2.5">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-gold-500" aria-hidden="true" />
                <p className="text-sm leading-relaxed">{welcome}</p>
              </div>
            </div>
          )}

          {turns.map((turn) => (
            <MessageBubble
              key={turn.id}
              turn={turn}
              onFeedback={turn.role === 'assistant' ? submitFeedback : undefined}
              feedbackGiven={feedback[turn.id] ?? null}
            />
          ))}

          {sending && !streamingText && <TypingIndicator />}

          {streamingText && (
            <MessageBubble
              streaming
              turn={{
                id: 'streaming',
                role: 'assistant',
                content: streamingText,
                payload: streamingPayload as AssistantPayload | undefined,
                createdAt: new Date().toISOString(),
              }}
            />
          )}

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
          {showSuggestions && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {suggestions.slice(0, 4).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  disabled={!ready}
                  className={cn(
                    'rounded-full border border-default bg-surface-muted px-3 py-1.5 text-xs',
                    'hover:border-sierra-300 hover:bg-sierra-50 disabled:opacity-50',
                    'dark:hover:bg-sierra-900',
                  )}
                >
                  {suggestion}
                </button>
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
              Ask about Golden Sierra services
            </label>
            <Textarea
              id="chat-input"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Grow with the content, up to a sensible ceiling.
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
              placeholder={ready ? 'Ask about jobs, training, or hiring…' : 'Connecting…'}
              disabled={!ready || sending}
              maxLength={2000}
              className="min-h-10 py-2.5"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!ready || sending || !input.trim()}
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
