'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MODE_OPENERS,
  type CounselorMessage,
  type CounselorTurn,
  type ProgramMatch,
  type SessionMode,
} from '@/types/counselor';

/**
 * Counselor session UI.
 *
 * Two columns: the conversation, and the context rail that shows what has
 * been understood so far and how far the candidate set has narrowed. The rail
 * is driven entirely by the turn payload — nothing on it is hardcoded, and
 * the counts are null unless the program catalogue actually returned them.
 */

const TOKEN_KEY = 'gs_counselor_session';

export function Session() {
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [messages, setMessages] = useState<CounselorMessage[]>([]);
  const [turn, setTurn] = useState<CounselorTurn | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);

  const session = useRef<{ id: string; token: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Resume an in-progress session on reload.
  useEffect(() => {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    (async () => {
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
  }, [messages, busy]);

  const begin = useCallback(async (chosen: SessionMode) => {
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: chosen }),
      });
      if (!res.ok) throw new Error('Could not start');
      const data = (await res.json()) as { sessionId: string; sessionToken: string };
      session.current = { id: data.sessionId, token: data.sessionToken };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session.current));
      setMode(chosen);
      setMessages([]);
      setTurn(null);
    } catch {
      setError('Could not start a session. Please refresh and try again.');
    }
  }, []);

  const send = useCallback(
    async (text: string, forceResults = false) => {
      const body = text.trim();
      if ((!body && !forceResults) || busy || !session.current) return;

      setError(null);
      setInput('');
      setBusy(true);
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
        if (!res.ok || !data.turn) throw new Error(data.error ?? 'Something went wrong.');

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
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy],
  );

  if (!mode) return <ModeChooser onChoose={begin} error={error} />;

  const opener = MODE_OPENERS[mode];
  const latest = turn;

  return (
    <div className="gs">
      <div className="gs-main">
        <header className="gs-top">
          <div className="gs-brand">
            <div className="gs-mark" aria-hidden="true">GS</div>
            <div>
              <b>Workforce Navigator</b>
              <small>Placer · El Dorado · Alpine counties</small>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <span className="gs-modepill">{mode === 'helper' ? 'Helping someone' : 'For myself'}</span>
            <button
              className="gs-rail-toggle"
              onClick={() => setRailOpen((v) => !v)}
              aria-expanded={railOpen}
            >
              What I know
            </button>
            <button
              className="gs-rail-toggle"
              onClick={() => {
                sessionStorage.removeItem(TOKEN_KEY);
                setMode(null);
                setMessages([]);
                setTurn(null);
              }}
            >
              Start over
            </button>
          </div>
        </header>

        <div className="gs-scroll" ref={scrollRef} role="log" aria-live="polite">
          <div className="gs-thread">
            {messages.length === 0 && (
              <div className="gs-row">
                <div className="gs-av bot" aria-hidden="true">GS</div>
                <div className="gs-bubble">
                  <p><strong>{opener.title}</strong></p>
                  <p>{opener.body}</p>
                  <div className="gs-replies">
                    {opener.replies.map((r) => (
                      <button key={r} className="gs-reply" onClick={() => void send(r)} disabled={busy}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div className="gs-row user" key={m.id}>
                  <div className="gs-bubble">{m.content}</div>
                  <div className="gs-av me" aria-hidden="true">You</div>
                </div>
              ) : (
                <AssistantTurn
                  key={m.id}
                  message={m}
                  isLatest={i === messages.length - 1}
                  busy={busy}
                  onReply={(v) => void send(v)}
                />
              ),
            )}

            {busy && (
              <div className="gs-row">
                <div className="gs-av bot" aria-hidden="true">GS</div>
                <div className="gs-bubble gs-typing" aria-label="Thinking">
                  <i /><i /><i />
                </div>
              </div>
            )}

            {error && <div className="gs-err">{error}</div>}
          </div>
        </div>

        <div className="gs-composer">
          <form
            className="gs-composer-in"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              id="gsInput"
              ref={inputRef}
              rows={1}
              value={input}
              disabled={busy}
              maxLength={2000}
              placeholder="Type your answer..."
              aria-label="Type your answer"
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <button className="gs-send" type="submit" disabled={busy || !input.trim()} aria-label="Send">
              ↑
            </button>
            <button
              type="button"
              className="gs-results-btn"
              disabled={busy || !latest?.canShowResults}
              onClick={() => void send('Show me what fits', true)}
              title={latest?.canShowResults ? 'See matching services' : 'Answer a little more first'}
            >
              See Results
            </button>
          </form>
          <p className="gs-foot">
            Golden Sierra staff confirm who qualifies — this tool points you to what may fit · (916) 746-7722
          </p>
        </div>
      </div>

      <ContextRail turn={latest} open={railOpen} onClose={() => setRailOpen(false)} />
    </div>
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
    <div className="gs-choose">
      <div className="gs-choose-in">
        <div className="gs-mark" style={{ margin: '0 auto', width: 48, height: 48, fontSize: 17 }}>
          GS
        </div>
        <h1>Let&apos;s find the right support</h1>
        <p>
          A few short questions — then services that actually fit the situation, with the sources
          behind them.
        </p>
        {error && <div className="gs-err" style={{ marginBottom: 16 }}>{error}</div>}
        <div className="gs-choose-cards">
          <button className="gs-choose-card" onClick={() => onChoose('self')}>
            <b>I&apos;m looking for myself</b>
            <span>Work, training, or help paying for it.</span>
          </button>
          <button className="gs-choose-card" onClick={() => onChoose('helper')}>
            <b>I&apos;m helping someone</b>
            <span>A client, a student, or a family member.</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  isLatest,
  busy,
  onReply,
}: {
  message: CounselorMessage;
  isLatest: boolean;
  busy: boolean;
  onReply: (value: string) => void;
}) {
  const t = message.turn;
  return (
    <div className="gs-row">
      <div className="gs-av bot" aria-hidden="true">GS</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="gs-bubble">
          {message.content.split('\n').filter(Boolean).map((p, i) => (
            <p key={i}>{p}</p>
          ))}

          {t?.assumption && (
            <div className="gs-assume">
              <b>Assuming from what you&apos;ve told me</b>
              {t.assumption.text}
              <button onClick={() => onReply("That's not quite right — let me correct that")}>
                That&apos;s not right
              </button>
            </div>
          )}

          {/* Quick replies submit genuine messages — never decorative. */}
          {isLatest && t?.quickReplies && t.quickReplies.length > 0 && (
            <div className="gs-replies">
              {t.quickReplies.map((r) => (
                <button
                  key={r.value}
                  className="gs-reply"
                  disabled={busy}
                  onClick={() => onReply(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {t?.stage === 'results' && t.recommendations.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {t.recommendations.map((r) => (
              <Recommendation key={r.id} match={r} />
            ))}
            {t.sources.length > 0 && (
              <p className="gs-explain" style={{ marginTop: 10 }}>
                Sources:{' '}
                {t.sources.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ' · '}
                    {s.url ? (
                      <a className="gs-link" href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}
                  </span>
                ))}
              </p>
            )}
            {!t.grounded && (
              <div className="gs-assume" style={{ marginTop: 10 }}>
                <b>Worth checking</b>
                These suggestions come from our service records rather than indexed source pages.
                Please confirm details with staff on (916) 746-7722.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Recommendation({ match }: { match: ProgramMatch }) {
  const stateLabel: Record<string, string> = {
    eligible: 'Likely fit',
    potential: 'Possible fit',
    needs_verification: 'Worth checking',
  };
  return (
    <div className="gs-rec">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
        <h4>{match.name}</h4>
        <span className={`gs-state ${match.state}`}>{stateLabel[match.state] ?? match.state}</span>
      </div>
      <div className="where">
        {match.counties.length ? match.counties.join(' · ') : 'Service area not specified'}
        {match.category ? ` — ${match.category}` : ''}
      </div>
      <p>{match.shortDescription}</p>

      {match.reasons.length > 0 && (
        <ul>
          {match.reasons.slice(0, 3).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {match.openQuestions.length > 0 && (
        <p style={{ fontSize: 12.5, color: '#8a6d12' }}>
          <strong>To confirm:</strong> {match.openQuestions.slice(0, 2).join('; ')}
        </p>
      )}

      {match.nextSteps && (
        <p style={{ fontSize: 12.5 }}>
          <strong>Next step:</strong> {match.nextSteps}
        </p>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {match.officialUrl && (
          <a className="gs-link" href={match.officialUrl} target="_blank" rel="noopener noreferrer">
            Official page ↗
          </a>
        )}
        {match.contactPhone && (
          <a className="gs-link" href={`tel:${match.contactPhone.replace(/\D/g, '')}`}>
            {match.contactPhone}
          </a>
        )}
      </div>
    </div>
  );
}

function ContextRail({
  turn,
  open,
  onClose,
}: {
  turn: CounselorTurn | null;
  open: boolean;
  onClose: () => void;
}) {
  const facts = turn?.knownFacts ?? [];
  const n = turn?.narrowing;

  return (
    <aside className={`gs-rail${open ? ' open' : ''}`} aria-label="What I know so far">
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>What I know so far</h3>
          <button
            className="gs-rail-toggle"
            onClick={onClose}
            style={{ display: open ? 'inline-block' : undefined }}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>

        {facts.length === 0 ? (
          <p className="gs-empty">
            Nothing yet. As you answer, the details that shape your options will appear here.
          </p>
        ) : (
          facts.map((f) => (
            <div className="gs-fact" key={f.key}>
              <span className={`gs-tick ${f.state}`} aria-hidden="true">
                {f.state === 'known' ? '✓' : '○'}
              </span>
              <span className="gs-fact-body">
                <b>{f.label}</b>
                <span>
                  {f.dimension}
                  {f.inferred ? ' · inferred' : ''}
                </span>
              </span>
            </div>
          ))
        )}
      </section>

      <section>
        <h3>Narrowing</h3>
        {n?.candidates != null && n.total != null ? (
          <>
            <div className="gs-count">
              {n.candidates} <small>of {n.total} services still match</small>
            </div>
            <div className="gs-dots" aria-hidden="true">
              {Array.from({ length: n.total }).map((_, i) => (
                <span key={i} className={`gs-dot${i < (n.candidates ?? 0) ? ' on' : ''}`} />
              ))}
            </div>
          </>
        ) : (
          <div className="gs-count" style={{ fontSize: 15, letterSpacing: 0 }}>
            Searching available workforce resources
          </div>
        )}
        <p className="gs-explain">{n?.explanation ?? 'Tell me a little and I’ll start narrowing.'}</p>

        {n?.criteria && (
          <div style={{ marginTop: 14 }}>
            {n.criteria.map((c) => (
              <div className="gs-crit" key={c.key}>
                <span className={c.applied ? undefined : 'off'}>{c.label}</span>
                <span className={c.applied ? undefined : 'off'}>{c.applied ? '✓' : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
