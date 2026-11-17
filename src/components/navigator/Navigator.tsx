'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import s from './navigator.module.css';
import { Markdown } from '@/components/chat/Markdown';
import { KnownFactsSidebar, NarrowingIndicator } from './Sidebar';
import { RecommendationResults, SourceCitation } from './Results';
import type { AssistantPayload, ChatTurn } from '@/types/chat';
import type { QuickReply, SessionMode } from '@/types/counselor';
import type { NarrowingCounts } from '@/types/navigator';

/**
 * Golden Sierra Workforce Navigator (admin chat).
 *
 * Same backend contract as before — a session from /api/chat/session and NDJSON turns from /api/chat —
 * with the chosen mode sent on each turn. Layout follows the reference description: charcoal header,
 * warm canvas, white assistant cards on the left, gold user bubbles on the right, outlined quick
 * replies, a gold "See Results" action, and a "What I know so far" / "Narrowing" sidebar that
 * collapses into a drawer on small screens.
 */

const TOKEN_KEY = 'gs_navigator_session';

type StreamEvent =
  | ({ type: 'meta' } & Partial<AssistantPayload>)
  | { type: 'token'; value: string }
  | { type: 'done'; messageId: string; answer: string; payload: AssistantPayload }
  | { type: 'error'; error: string };

type Stored = { id: string; token: string; mode: SessionMode };

export function ModeSelection({ onPick, disabled }: { onPick: (m: SessionMode) => void; disabled?: boolean }) {
  return (
    <div className={s.modes} data-testid="mode-selection">
      <h2>How can the Navigator help today?</h2>
      <p>Describe the situation in your own words. I&apos;ll ask a few short questions, then show jobs, training and services from the indexed sources.</p>
      <div className={s.modeGrid}>
        <button className={s.modeCard} onClick={() => onPick('helper')} disabled={disabled} data-testid="mode-helper">
          <div className={s.modeIcon} aria-hidden="true">🤝</div>
          <strong>I&apos;m helping someone</strong>
          <span>For staff, counselors and advisors supporting a job seeker. I&apos;ll talk about them in the third person.</span>
        </button>
        <button className={s.modeCard} onClick={() => onPick('self')} disabled={disabled} data-testid="mode-self">
          <div className={s.modeIcon} aria-hidden="true">🧭</div>
          <strong>I&apos;m looking for myself</strong>
          <span>Find work, training or support for yourself, based on your experience and goals.</span>
        </button>
      </div>
    </div>
  );
}

export function ConversationHeader({ mode, onRestart, onToggleSide, factCount }: { mode: SessionMode | null; onRestart: () => void; onToggleSide: () => void; factCount: number }) {
  return (
    <header className={s.header}>
      <div className={s.brand}>
        <div className={s.brandMark} aria-hidden="true">GS</div>
        <div className={s.brandText}>
          <strong>Golden Sierra</strong>
          <small>Workforce Navigator</small>
        </div>
      </div>
      {mode && (
        <span className={s.modePill} data-testid="mode-pill">
          {mode === 'helper' ? 'Helping someone' : 'Looking for myself'}
        </span>
      )}
      {mode && (
        <button className={`${s.headerBtn} ${s.sideToggle}`} onClick={onToggleSide} aria-label="Show what I know so far" data-testid="side-toggle">
          What I know ({factCount})
        </button>
      )}
      {mode && (
        <button className={s.headerBtn} onClick={onRestart} data-testid="start-over" style={{ marginLeft: mode ? undefined : 'auto' }}>
          ↻ Start over
        </button>
      )}
      <a className={s.headerBtn} href="/admin" style={{ textDecoration: 'none', marginLeft: mode ? undefined : 'auto' }}>
        Leave
      </a>
    </header>
  );
}

function UserMessageBubble({ text }: { text: string }) {
  return (
    <div className={`${s.row} ${s.rowUser}`} data-testid="user-message">
      <div className={`${s.avatar} ${s.avatarUser}`} aria-hidden="true">You</div>
      <div className={s.userBubble}>{text}</div>
    </div>
  );
}

function AssistantMessageCard({ turn, they }: { turn: ChatTurn; they: string }) {
  const p = turn.payload;
  const results = p?.navigator?.results;
  return (
    <>
      <div className={s.row} data-testid="assistant-message">
        <div className={`${s.avatar} ${s.avatarBot}`} aria-hidden="true">GS</div>
        <div className={s.assistantCard}>
          <Markdown content={turn.content} citations={p?.citations ?? []} />
          {!!p?.citations?.length && (
            <div className={s.sources} data-testid="citations">
              {p.citations.map((c) => (
                <SourceCitation key={c.id} n={c.id} title={c.title} url={c.url} />
              ))}
            </div>
          )}
        </div>
      </div>
      {results && <RecommendationResults results={results} citations={p?.citations ?? []} they={they} />}
    </>
  );
}

export function QuickReplyGroup({ replies, onPick }: { replies: QuickReply[]; onPick: (v: string) => void }) {
  if (!replies.length) return null;
  return (
    <div className={s.quickRow} data-testid="quick-replies">
      {replies.map((r) => (
        <button key={r.value} className={s.quick} data-testid="quick-reply" onClick={() => onPick(r.value)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function LoadingState() {
  return (
    <div className={s.row} aria-label="Searching the indexed sources">
      <div className={`${s.avatar} ${s.avatarBot}`} aria-hidden="true">GS</div>
      <div className={s.assistantCard}>
        <span className={s.typing}><i /><i /><i /></span>
      </div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <div className={s.error} role="alert">{message}</div>;
}

export function ChatComposer(props: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; showResults: boolean; onResults: () => void; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  return (
    <div className={s.composer}>
      <form
        className={s.composerRow}
        onSubmit={(e) => {
          e.preventDefault();
          props.onSend();
        }}
      >
        <label htmlFor="navInput" style={{ position: 'absolute', left: -9999 }}>Message</label>
        <textarea
          id="navInput"
          ref={props.inputRef}
          className={s.input}
          rows={1}
          maxLength={2000}
          value={props.value}
          disabled={props.disabled}
          placeholder="Describe the situation, answer the question, or ask about a program…"
          onChange={(e) => {
            props.onChange(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 130)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        {props.showResults && (
          <button type="button" className={s.seeResults} onClick={props.onResults} data-testid="show-results">
            See Results
          </button>
        )}
        <button className={s.send} type="submit" disabled={props.disabled || !props.value.trim()} aria-label="Send">
          ↑
        </button>
      </form>
      <p className={s.foot}>Facts come only from indexed Golden Sierra sources. Staff confirm who qualifies · (916) 746-7722</p>
    </div>
  );
}

export function Navigator() {
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const session = useRef<Stored | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Resume an in-progress conversation on reload.
  useEffect(() => {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    void (async () => {
      try {
        const parsed = JSON.parse(raw) as Stored;
        const res = await fetch(`/api/chat/session/${parsed.id}?token=${encodeURIComponent(parsed.token)}`);
        if (!res.ok) throw new Error('expired');
        const data = (await res.json()) as { messages: ChatTurn[] };
        session.current = parsed;
        setMode(parsed.mode);
        setTurns(data.messages);
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
      }
    })();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, sending]);

  const pick = useCallback(async (m: SessionMode) => {
    setError(null);
    try {
      const res = await fetch('/api/chat/session', { method: 'POST' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { sessionId: string; sessionToken: string };
      session.current = { id: data.sessionId, token: data.sessionToken, mode: m };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session.current));
      setTurns([]);
      setMode(m);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      setError('Could not start a conversation. Is the server running?');
    }
  }, []);

  const restart = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    session.current = null;
    setTurns([]);
    setMode(null);
    setError(null);
  }, []);

  const send = useCallback(
    async (text: string, forceResults = false) => {
      const q = text.trim();
      if (!q || sending || !session.current) return;
      setError(null);
      setInput('');
      setSending(true);
      setTurns((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', content: q, createdAt: new Date().toISOString() }]);
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q, sessionToken: session.current.token, stream: true, mode: session.current.mode, ...(forceResults ? { forceResults: true } : {}) }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'The assistant could not answer that.');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
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
            if (evt.type === 'done') {
              const d = evt;
              setTurns((prev) => [...prev, { id: d.messageId, role: 'assistant', content: d.answer, payload: d.payload, createdAt: new Date().toISOString() }]);
            } else if (evt.type === 'error') setError(evt.error);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [sending],
  );

  const assistant = turns.filter((t) => t.role === 'assistant');
  const latest = assistant.at(-1)?.payload;
  const flow = [...assistant].reverse().find((t) => t.payload?.flow)?.payload?.flow ?? null;
  const facts = flow?.knownFacts ?? {};
  const narrowHistory = assistant.map((t) => t.payload?.navigator?.narrowing).filter(Boolean) as NarrowingCounts[];
  const quickReplies = !sending && latest?.flow ? latest.flow.quickReplies : [];
  const showResults = Boolean(!sending && flow?.canShowResults && (flow.stage === 'DISCOVERING_NEEDS' || flow.stage === 'CLARIFYING'));
  const they = mode === 'helper' ? 'they' : 'you';

  return (
    <div className={s.shell} data-testid="navigator">
      <ConversationHeader mode={mode} onRestart={restart} onToggleSide={() => setSideOpen((v) => !v)} factCount={Object.keys(facts).length} />
      {!mode ? (
        <div className={s.log}>
          <ModeSelection onPick={(m) => void pick(m)} />
          {error && <ErrorState message={error} />}
        </div>
      ) : (
        <div className={s.body}>
          <div className={s.main}>
            <div className={s.log} ref={logRef} role="log" aria-live="polite">
              {turns.length === 0 && (
                <div className={s.row}>
                  <div className={`${s.avatar} ${s.avatarBot}`} aria-hidden="true">GS</div>
                  <div className={s.assistantCard} data-testid="opener">
                    {mode === 'helper'
                      ? 'Tell me about the person you’re helping — their situation, the kind of work they’re interested in, and anything that might get in the way. I’ll ask one question at a time.'
                      : 'Tell me about your situation — the work you’ve done, what you’re looking for, and anything that might get in the way. I’ll ask one question at a time.'}
                  </div>
                </div>
              )}
              {turns.map((t) => (t.role === 'user' ? <UserMessageBubble key={t.id} text={t.content} /> : <AssistantMessageCard key={t.id} turn={t} they={they} />))}
              <QuickReplyGroup replies={quickReplies} onPick={(v) => void send(v)} />
              {sending && <LoadingState />}
              {error && <ErrorState message={error} />}
            </div>
            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={() => void send(input)}
              disabled={sending}
              showResults={showResults}
              onResults={() => void send('Show me the options you have so far', true)}
              inputRef={inputRef}
            />
          </div>
          <aside className={`${s.side} ${sideOpen ? s.sideOpen : ''}`} aria-label="What I know so far">
            <KnownFactsSidebar facts={facts} />
            <NarrowingIndicator history={narrowHistory} />
          </aside>
        </div>
      )}
    </div>
  );
}
