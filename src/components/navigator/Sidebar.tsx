'use client';

import s from './navigator.module.css';
import type { NarrowingCounts } from '@/types/navigator';

const FACT_LABELS: Record<string, string> = {
  who: 'Who this is for',
  situation: 'Situation',
  careerInterest: 'Career pathway',
  desiredRole: 'Role wanted',
  experience: 'Experience',
  rolePreference: 'Role preference',
  degree: 'Degree',
  certifications: 'Certifications & licenses',
  experienceYears: 'Experience (years)',
  currentTraining: 'Current training',
  education: 'Education',
  geography: 'Location & transport',
  county: 'County',
  transportation: 'Transportation',
  incomeUrgency: 'Income urgency',
  employmentStatus: 'Employment',
  age: 'Age',
  audience: 'Looking as',
};

export function KnownFactsSidebar({ facts }: { facts: Record<string, string> }) {
  const entries = Object.entries(facts);
  return (
    <div data-testid="known-facts">
      <h2 className={s.sideTitle}>What I know so far</h2>
      {entries.length === 0 ? (
        <p className={s.empty}>Nothing yet. Only what is shared in this conversation is kept, and only for this conversation.</p>
      ) : (
        entries.map(([k, v]) => (
          <div className={s.fact} key={k} data-fact={k}>
            <span className={s.factTick} aria-hidden="true">✓</span>
            <span>
              <span className={s.factLabel}>{FACT_LABELS[k] ?? k.replace(/([A-Z])/g, ' $1')}</span>
              {v}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function Bar({ total, open, unmet }: { total: number; open: number; unmet: number }) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className={s.bar} role="img" aria-label={`${open} of ${total}`}>
      <span className={s.barOpen} style={{ width: pct(open - unmet) }} />
      <span className={s.barUnmet} style={{ width: pct(unmet) }} />
    </div>
  );
}

/**
 * Narrowing from real matching data only: job listings by role relation, deadline and published
 * requirements; catalogue services by confirmed rule exclusions. `history` is one entry per turn.
 */
export function NarrowingIndicator({ history }: { history: NarrowingCounts[] }) {
  const now = history.at(-1);
  return (
    <div data-testid="narrowing">
      <h2 className={s.sideTitle}>Narrowing</h2>
      {!now ? (
        <p className={s.empty}>Searching starts once there is something to go on — describe the situation, or ask a question.</p>
      ) : (
        <>
          <div className={s.narrowStep} data-testid="narrow-listings">
            <div className={s.narrowHead}>
              <span>Job listings</span>
              <b>
                {now.listings.open} of {now.listings.total}
              </b>
            </div>
            <Bar total={now.listings.total} open={now.listings.open} unmet={now.listings.unmet} />
            <div className={s.legend}>
              <span>{now.listings.relevant} related to the roles described</span>
              {now.listings.closed > 0 && <span>{now.listings.closed} past deadline</span>}
              {now.listings.unmet > 0 && (
                <span>
                  <i className={s.dot} style={{ background: 'var(--gs-tobacco-light)' }} />
                  {now.listings.unmet} with a requirement not met
                </span>
              )}
            </div>
          </div>
          <div className={s.narrowStep} data-testid="narrow-programs">
            <div className={s.narrowHead}>
              <span>Services in the catalogue</span>
              <b>
                {now.programs.possible} of {now.programs.total}
              </b>
            </div>
            <Bar total={now.programs.total} open={now.programs.possible} unmet={0} />
            <div className={s.legend}>
              {now.programs.excluded > 0 && <span>{now.programs.excluded} ruled out by a published rule</span>}
              <span>{now.programs.unconfirmed} need staff confirmation</span>
            </div>
          </div>
          {history.length > 1 && (
            <p className={s.trail} data-testid="narrow-trail">
              Listings by turn: {history.map((h) => h.listings.open).join(' → ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
