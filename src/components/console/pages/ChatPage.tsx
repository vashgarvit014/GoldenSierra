'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Head, useConsole } from '../Console';
import { Markdown } from '@/components/chat/Markdown';
import { STARTER_QUESTIONS, type AssistantPayload, type ChatTurn } from '@/types/chat';

/**
 * The live assistant, inside the console shell.
 *
 * This is the real pipeline — it opens a session, streams NDJSON from
 * /api/chat, and renders the citations and program matches that come back. The
 * prototype's canned replies are gone entirely.
 */

const TOKEN_KEY = 'gs_console_session';

type StreamEvent =
  | ({ type: 'meta' } & Partial<AssistantPayload>)
  | { type: 'token'; value: string }
  | { type: 'done'; messageId: string; answer: string; payload: AssistantPayload }
  | { type: 'error'; error: string };

export function ChatPage() {
  const { notify } = useConsole();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [liveMeta, setLiveMeta] = useState<Partial<AssistantPayload> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([...STARTER_QUESTIONS]);

  const session = useRef<{ id: string; token: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const start = useCallback(async (fresh = false) => {
    setReady(false);
    setError(null);
    if (fresh) {
      sessionStorage.removeItem(TOKEN_KEY);
      setTurns([]);
      setSuggestions([...STARTER_QUESTIONS]);
    }

    const stored = fresh ? null : sessionStorage.getItem(TOKEN_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { id: string; token: string };
        const res = await fetch(
          `/api/chat/session/${parsed.id}?token=${encodeURIComponent(parsed.token)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { messages: ChatTurn[] };
          session.current = parsed;
          setTurns(data.messages);
          const last = data.messages.at(-1);
          if (last?.payload?.followUpSuggestions?.length) {
            setSuggestions(last.payload.followUpSuggestions);
          }
          setReady(true);
          return;
        }
      } catch {
        /* fall through to a fresh session */
      }
      sessionStorage.removeItem(TOKEN_KEY);
    }

    try {
      const res = await fetch('/api/chat/session', { method: 'POST' });
      if (!res.ok) throw new Error('Could not start a conversation');
      const data = (await res.json()) as { sessionId: string; sessionToken: string };
      session.current = { id: data.sessionId, token: data.sessionToken };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session.current));
      setReady(true);
    } catch {
      setError('Could not connect to the assistant. Is the server running?');
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, streaming]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || sending || !session.current) return;

      setError(null);
      setInput('');
      setSending(true);
      setStreaming('');
      setLiveMeta(null);
      setTurns((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: 'user', content: q, createdAt: new Date().toISOString() },
      ]);

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q, sessionToken: session.current.token, stream: true }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'The assistant could not answer that.');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let acc = '';

        // NDJSON: one event per line; a partial line waits for the next chunk.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: StreamEvent;
            try {
              evt = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }

            if (evt.type === 'meta') {
              setLiveMeta(evt);
            } else if (evt.type === 'token') {
              acc += evt.value;
              setStreaming(acc);
            } else if (evt.type === 'done') {
              setTurns((prev) => [
                ...prev,
                {
                  id: evt.messageId,
                  role: 'assistant',
                  // The finalized text, not the raw stream: citations have been
                  // renumbered and overclaims softened server-side.
                  content: evt.answer,
                  payload: evt.payload,
                  createdAt: new Date().toISOString(),
                },
              ]);
              setStreaming('');
              setLiveMeta(null);
              if (evt.payload.followUpSuggestions.length) {
                setSuggestions(evt.payload.followUpSuggestions);
              }
            } else if (evt.type === 'error') {
              setError(evt.error);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setStreaming('');
        setLiveMeta(null);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [sending],
  );

  const empty = turns.length === 0 && !streaming;

  return (
    <>
      <Head
        eyebrow="LIVE ASSISTANT"
        title="AI Workforce Chat"
        sub="Grounded in the indexed knowledge base. Every answer carries citations."
        action={
          <button className="btn" onClick={() => void start(true)} disabled={sending}>
            ↻ &nbsp; New conversation
          </button>
        }
      />

      <div className="chat-shell">
        <div className="chat-panel">
          <div className="chat-top">
            <div className="assistant-title">
              <div className="botmark" aria-hidden="true">
                ✦
              </div>
              <div>
                <strong style={{ fontSize: 13 }}>Workforce Navigator</strong>
                <br />
                <small className="muted">Placer · El Dorado · Alpine counties</small>
              </div>
            </div>
            <span className="top-badge">
              <span className="dot" /> {ready ? 'CONNECTED' : 'CONNECTING'}
            </span>
          </div>

          <div className="chat-body" ref={bodyRef} role="log" aria-live="polite">
            {empty && (
              <>
                <div className="welcome" id="welcome">
                  <div className="welcome-icon" aria-hidden="true">
                    ✦
                  </div>
                  <h2>How can I help you today?</h2>
                  <p>
                    Ask about job search support, training, scholarships, paid internships, or
                    hiring help for employers. Answers are drawn from Golden Sierra&apos;s indexed
                    content with sources attached.
                  </p>
                </div>
                <div className="prompts" id="prompts">
                  {STARTER_QUESTIONS.map((p) => (
                    <button key={p} className="prompt" onClick={() => void send(p)} disabled={!ready}>
                      {p}
                    </button>
                  ))}
                </div>
              </>
            )}

            {turns.map((turn) =>
              turn.role === 'user' ? (
                <div className="message user" key={turn.id}>
                  <div className="bubble">{turn.content}</div>
                </div>
              ) : (
                <AssistantMessage key={turn.id} turn={turn} />
              ),
            )}

            {sending && !streaming && (
              <div className="message">
                <div className="bubble typing" aria-label="Searching the knowledge base">
                  <i /> <i /> <i />
                </div>
              </div>
            )}

            {streaming && (
              <div className="message">
                <div className="bubble">
                  <div className="answer">
                    <Markdown content={streaming} citations={liveMeta?.citations ?? []} />
                  </div>
                  <span className="caret" />
                </div>
              </div>
            )}

            {error && <div className="err">{error}</div>}
          </div>

          <div className="chat-composer">
            {!sending && suggestions.length > 0 && !empty && (
              <div className="sources" style={{ marginBottom: 10 }}>
                {suggestions.slice(0, 3).map((s) => (
                  <button key={s} className="source-chip" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}

            <form
              className="chat-inputrow"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <label htmlFor="chatInput" className="sr-only" style={{ display: 'none' }}>
                Ask a question
              </label>
              <textarea
                id="chatInput"
                ref={inputRef}
                value={input}
                rows={1}
                maxLength={2000}
                disabled={!ready || sending}
                placeholder={ready ? 'Ask about jobs, training, or hiring…' : 'Connecting…'}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 130)}px`;
                }}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <button className="send" type="submit" disabled={!ready || sending || !input.trim()} aria-label="Send">
                {sending ? <span className="spin" /> : '↑'}
              </button>
            </form>
            <p className="chat-foot">
              Shares published information and cannot decide eligibility — Golden Sierra staff
              confirm who qualifies · (916) 746-7722
            </p>
          </div>
        </div>

        <aside className="chat-side">
          <div className="side-card">
            <h3>This conversation</h3>
            <ConversationFacts turns={turns} live={liveMeta} />
          </div>

          <div className="side-card">
            <h3>Try asking</h3>
            {STARTER_QUESTIONS.slice(0, 5).map((p) => (
              <div
                className="link-row"
                key={p}
                role="button"
                tabIndex={0}
                onClick={() => void send(p)}
                onKeyDown={(e) => e.key === 'Enter' && void send(p)}
              >
                › {p}
              </div>
            ))}
          </div>

          <div className="notice">
            Answers are generated from indexed Golden Sierra content. Eligibility is confirmed by
            agency staff, never by the assistant.
          </div>
        </aside>
      </div>
    </>
  );
}

/** Live profile + intent, so an operator can see what the pipeline inferred. */
function ConversationFacts({
  turns,
  live,
}: {
  turns: ChatTurn[];
  live: Partial<AssistantPayload> | null;
}) {
  const latest = live ?? [...turns].reverse().find((t) => t.payload)?.payload ?? null;
  if (!latest) return <p className="info-note">Nothing inferred yet — ask a question.</p>;

  const profile = latest.profile ?? {};
  const entries = Object.entries(profile).filter(([, v]) => v != null && v !== '');

  return (
    <>
      {latest.intent && (
        <div className="system-item">
          <span>Detected intent</span>
          <span className="tag">{latest.intent.replace(/_/g, ' ')}</span>
        </div>
      )}
      {entries.length === 0 ? (
        <p className="info-note" style={{ marginTop: 10 }}>
          No personal details shared yet. The assistant only keeps what you volunteer.
        </p>
      ) : (
        entries.map(([key, value]) => (
          <div className="system-item" key={key}>
            <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            <span className="muted">{Array.isArray(value) ? value.join(', ') : String(value)}</span>
          </div>
        ))
      )}
    </>
  );
}

function AssistantMessage({ turn }: { turn: ChatTurn }) {
  const [showSources, setShowSources] = useState(false);
  const [rated, setRated] = useState<string | null>(null);
  const payload = turn.payload;

  const rate = async (rating: 'HELPFUL' | 'NOT_HELPFUL') => {
    setRated(rating);
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as { id: string; token: string };
    await fetch('/api/chat/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.id,
        sessionToken: s.token,
        messageId: turn.id,
        rating,
      }),
    }).catch(() => undefined); // feedback is best-effort
  };

  return (
    <div className="message">
      <div style={{ flex: 1 }}>
        <div className="bubble">
          <div className="answer">
            <Markdown
              content={turn.content}
              citations={payload?.citations ?? []}
              onCitationClick={() => setShowSources(true)}
            />
          </div>

          {payload && !payload.grounded && (
            <div className="callout" style={{ marginTop: 12 }}>
              This answer is not backed by indexed sources. Please confirm anything important by
              calling (916) 746-7722.
            </div>
          )}

          {payload?.conflicts?.map((c, i) => (
            <div className="callout" style={{ marginTop: 12 }} key={i}>
              <b>Sources disagree</b> about {c.topic}. Staff can confirm which is current.
            </div>
          ))}

          {!!payload?.citations?.length && (
            <>
              <div className="sources">
                <button className="source-chip" onClick={() => setShowSources((v) => !v)}>
                  {showSources ? '▾ Hide sources' : `▸ ${payload.citations.length} sources`}
                </button>
                {payload.recommendations?.length ? (
                  <span className="source-chip">{payload.recommendations.length} matched services</span>
                ) : null}
              </div>

              {showSources && (
                <div style={{ marginTop: 10 }}>
                  {payload.citations.map((c) => (
                    <div className="link-row" key={c.id}>
                      <span className="tag">{c.id}</span>
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noopener noreferrer">
                          {c.title}
                        </a>
                      ) : (
                        <span>{c.title}</span>
                      )}
                      {c.documentType === 'PDF' && <span className="tag">PDF</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {payload?.recommendations?.map((r) => (
          <div className="rec" key={r.slug ?? r.name}>
            <h4>{r.name}</h4>
            <p>{r.shortDescription}</p>
            <div className="why">
              <b>Why this fits:</b> {r.whyRelevant}
            </div>
            {r.nextSteps && (
              <div className="why">
                <b>Next step:</b> {r.nextSteps}
              </div>
            )}
            {r.officialUrl && (
              <div style={{ marginTop: 7 }}>
                <a className="tag" href={r.officialUrl} target="_blank" rel="noopener noreferrer">
                  Official page ↗
                </a>
              </div>
            )}
            {r.requiresVerification && <span className="verify">Staff confirm eligibility</span>}
          </div>
        ))}

        <div className="sources" style={{ marginTop: 10 }}>
          {rated ? (
            <span className="source-chip">✓ Thanks for the feedback</span>
          ) : (
            <>
              <span className="time" style={{ alignSelf: 'center' }}>
                Was this helpful?
              </span>
              <button className="source-chip" onClick={() => void rate('HELPFUL')}>
                👍 Yes
              </button>
              <button className="source-chip" onClick={() => void rate('NOT_HELPFUL')}>
                👎 No
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
