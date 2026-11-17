'use client';

import { useState } from 'react';
import s from './navigator.module.css';
import type { Citation, Recommendation } from '@/types/chat';
import type { JobMatch, NavigatorResults } from '@/types/navigator';

/**
 * Results in the reference's grouped layout. Every field shown comes from a verified source:
 * job cards from the extracted listing (verbatim against its document), program cards from the
 * cited chunk. Groups with nothing verified are not rendered.
 */

const KIND_LABEL: Record<JobMatch['kind'], string> = {
  exact: 'Role match',
  related: 'Related role',
  transferable: 'Transferable skills',
  sector: 'Same field',
};

export function SourceCitation({ title, url, n }: { title: string; url: string | null; n?: number }) {
  const label = (
    <>
      {n != null && <span className={s.sourceNum}>[{n}]</span>} {title}
    </>
  );
  return url && /^https?:/.test(url) ? (
    <a className={s.sourceLink} href={url} target="_blank" rel="noopener noreferrer" data-testid="source-link">
      {label} ↗
    </a>
  ) : (
    <span className={s.sourceLink} data-testid="source-link" title={url ?? undefined}>
      {label}
    </span>
  );
}

export function EmptyResultsState({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.emptyResults} data-testid="empty-results">
      {children}
    </div>
  );
}

function RecommendationDetails({ job }: { job: JobMatch }) {
  return (
    <div className={s.details} data-testid="job-details">
      {job.summary && (
        <div>
          <h4>From the listing</h4>
          {job.summary}
        </div>
      )}
      {job.requirements.length > 0 && (
        <div>
          <h4>Published requirements</h4>
          {job.requirements.map((r) => (
            <div className={s.req} key={r.text}>
              <span className={r.status === 'met' ? s.reqMet : r.status === 'unmet' ? s.reqUnmet : s.reqUnknown} aria-label={r.status}>
                {r.status === 'met' ? '✓' : r.status === 'unmet' ? '✕' : '?'}
              </span>
              <span>{r.text}</span>
            </div>
          ))}
          <p className={s.caveat}>✓ / ✕ compare the listing with what was shared in this conversation; ? means not known yet. The employer decides.</p>
        </div>
      )}
      {job.requiredSkills && (
        <div>
          <h4>Skills the listing asks for</h4>
          {job.requiredSkills}
        </div>
      )}
      {job.employmentType && (
        <div>
          <h4>Schedule / type</h4>
          {job.employmentType}
        </div>
      )}
      {job.contact && (
        <div>
          <h4>Contact (as listed)</h4>
          {job.contact}
        </div>
      )}
      <div>
        <h4>Source</h4>
        <SourceCitation title={job.source.title} url={job.source.url} />
        <p className={s.caveat}>
          Indexed {new Date(job.source.indexedAt).toLocaleDateString()}. This is an indexed listing, not a confirmed current
          opening — check the posting for availability.
        </p>
      </div>
    </div>
  );
}

export function JobMatchCard({ job }: { job: JobMatch }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={s.card} data-testid="job-card" data-kind={job.kind}>
      <div className={s.cardTop}>
        <div style={{ minWidth: 0 }}>
          <h4 className={s.cardTitle}>{job.title}</h4>
          {job.employer && <p className={s.cardOrg}>{job.employer}</p>}
        </div>
        <span className={`${s.badge} ${job.kind === 'exact' ? s.badgeExact : ''}`}>{KIND_LABEL[job.kind]}</span>
      </div>
      <div className={s.meta}>
        {job.occupation && <span className={s.metaItem}>{job.occupation.sector}</span>}
        {job.county && <span className={s.metaItem}>{job.county}</span>}
        {job.salary && <span className={s.metaItem}>{job.salary}</span>}
      </div>
      {job.reasons.length > 0 && (
        <div className={s.why}>
          <b>Why this fits</b>
          <ul>
            {job.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={`${s.status} ${job.listingStatus === 'closed' ? s.statusClosed : s.statusOpen}`}>{job.listingStatusLabel}</div>
      <div className={s.links}>
        {job.applyUrl && (
          <a className={s.linkBtn} href={job.applyUrl} target="_blank" rel="noopener noreferrer">
            Apply (employer site) ↗
          </a>
        )}
        {job.sourceUrl && job.sourceUrl !== job.applyUrl && (
          <a className={s.linkGhost} href={job.sourceUrl} target="_blank" rel="noopener noreferrer">
            Original posting ↗
          </a>
        )}
      </div>
      <button className={s.expand} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾ Hide details' : '▸ Details, requirements & source'}
      </button>
      {open && <RecommendationDetails job={job} />}
    </article>
  );
}

function ProgramCard({ rec, citations, kind }: { rec: Recommendation; citations: Citation[]; kind: 'training' | 'support' }) {
  const n = Number(/\[(\d+)\]/.exec(rec.category ?? '')?.[1] ?? /Source \[?(\d+)/.exec(rec.category ?? '')?.[1]);
  const cite = citations.find((c) => c.id === n);
  return (
    <article className={s.card} data-testid={kind === 'training' ? 'training-card' : 'support-card'}>
      <div className={s.cardTop}>
        <h4 className={s.cardTitle}>{rec.name}</h4>
        <span className={s.badge}>{kind === 'training' ? 'Training' : 'Service'}</span>
      </div>
      <p className={s.why} style={{ margin: 0 }}>“{rec.shortDescription}”</p>
      <div className={s.why}>
        <b>Why this fits:</b> {rec.whyRelevant}
      </div>
      <div className={s.sources}>
        <SourceCitation title={cite?.title ?? 'Source'} url={rec.officialUrl} n={Number.isFinite(n) ? n : undefined} />
      </div>
      <p className={s.caveat}>Golden Sierra staff confirm who qualifies.</p>
    </article>
  );
}

export const TrainingProgramCard = (p: { rec: Recommendation; citations: Citation[] }) => <ProgramCard {...p} kind="training" />;
export const SupportServiceCard = (p: { rec: Recommendation; citations: Citation[] }) => <ProgramCard {...p} kind="support" />;

export function RecommendationResults({ results, citations, they }: { results: NavigatorResults; citations: Citation[]; they: string }) {
  const any = results.bestJobs.length + results.relatedJobs.length + results.training.length + results.support.length > 0;
  return (
    <section className={s.results} data-testid="results">
      {results.roleSearch.own.length > 0 && (
        <p className={s.groupNote} data-testid="role-search">
          Roles searched: <b>{results.roleSearch.own.join(', ')}</b>
          {results.roleSearch.related.length > 0 && <> · widened to related roles: {results.roleSearch.related.join(', ')}</>}
        </p>
      )}
      {results.bestJobs.length > 0 && (
        <div className={s.group} data-testid="group-best">
          <h3>Best job matches</h3>
          <p className={s.groupNote}>Indexed listings for the kind of role {they} described.</p>
          <div className={s.cards}>{results.bestJobs.map((j) => <JobMatchCard key={j.id} job={j} />)}</div>
        </div>
      )}
      {results.relatedJobs.length > 0 && (
        <div className={s.group} data-testid="group-related">
          <h3>Related job opportunities</h3>
          <p className={s.groupNote}>Related roles, transferable skills or the same field — they may ask for more than {they} have shared.</p>
          <div className={s.cards}>{results.relatedJobs.map((j) => <JobMatchCard key={j.id} job={j} />)}</div>
        </div>
      )}
      {results.training.length > 0 && (
        <div className={s.group} data-testid="group-training">
          <h3>Training and career pathways</h3>
          <div className={s.cards}>{results.training.map((r) => <TrainingProgramCard key={r.slug ?? r.name} rec={r} citations={citations} />)}</div>
        </div>
      )}
      {results.support.length > 0 && (
        <div className={s.group} data-testid="group-support">
          <h3>Employment support services</h3>
          <div className={s.cards}>{results.support.map((r) => <SupportServiceCard key={r.slug ?? r.name} rec={r} citations={citations} />)}</div>
        </div>
      )}
      {!any && (
        <EmptyResultsState>
          No indexed job listing or catalogue service matched with verified evidence. The message above says what the indexed
          sources do and do not cover.
        </EmptyResultsState>
      )}
    </section>
  );
}
