import { SECTOR_LABELS, type Sector } from '../jobs/occupations';
import { certLabel, educationFacts } from '../jobs/requirements';
import { extractQuals } from '../jobs/qualifications';
import type { Question } from '../counselor/questions';
import type { ContextUpdate } from '../counselor/extract';
import type { CounselorContext, QuickReply } from '@/types/counselor';
import type { JobMatch } from '@/types/navigator';
import { listingReason, person } from './voice';

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Qualification questions chosen from the published requirements of the shortlisted listings.
 *
 * For every open, role-relevant listing near the top of the ranking, each MANDATORY requirement whose
 * status is still unknown names the facts that would decide it (education level, a certification or
 * license, years of experience in that line of work, age). The fact deciding the most shortlisted
 * listings is asked about — one question, with concise replies. Nothing is asked that no listing
 * requires: no degree question for a caregiver listing that publishes no education requirement.
 */

export type QualQuestion = { key: string; impact: number; listings: string[]; question: Question };

const SHORTLIST = 5;

function subject(ctx: CounselorContext) {
  const p = person(ctx);
  return { s: p.subj, haveQ: p.doHave, has: p.speakerHas, hasNot: p.speakerHasNot, p };
}

/** Facts that decide unknown mandatory requirements of the shortlist, with how many listings each decides. */
export function qualificationGaps(shortlist: JobMatch[]): Map<string, string[]> {
  const gaps = new Map<string, string[]>();
  for (const m of shortlist) {
    for (const r of m.requirements) {
      if (!r.mandatory || r.status !== 'unknown') continue;
      for (const k of r.decidedBy) gaps.set(k, [...new Set([...(gaps.get(k) ?? []), m.title])]);
    }
  }
  return gaps;
}

const PRIORITY = (k: string) => (k === 'edu' ? 0 : k.startsWith('cert:') ? 1 : k.startsWith('exp:') ? 2 : 3);

export function shortlistOf(matches: JobMatch[]): JobMatch[] {
  return matches.filter((m) => m.listingStatus !== 'closed').slice(0, SHORTLIST);
}

/**
 * The listings whose requirements are worth asking about: the role they described when there is one,
 * otherwise a related role (not a supervisory step up). Same-field or transferable-skill listings never drive a question — a clerk
 * is not asked about a degree that only a neighbouring accounting listing requires.
 */
export function targetShortlist(matches: JobMatch[]): JobMatch[] {
  const open = shortlistOf(matches);
  const exact = open.filter((m) => m.kind === 'exact');
  // A supervisory step up from a past role (cashier → sales manager) is not what they asked about.
  return exact.length ? exact : open.filter((m) => m.kind === 'related' && m.relation !== 'supervisory');
}

export function qualificationQuestion(ctx: CounselorContext, matches: JobMatch[], asked: string[]): QualQuestion | null {
  const gaps = [...qualificationGaps(targetShortlist(matches)).entries()].filter(([k]) => !asked.includes(`qual:${k}`));
  if (!gaps.length) return null;
  gaps.sort((a, b) => b[1].length - a[1].length || PRIORITY(a[0]) - PRIORITY(b[0]));
  const [key, listings] = gaps[0]!;
  const question = build(key, ctx, listings);
  return question ? { key, impact: listings.length, listings, question } : null;
}

function asQuestion(id: string, prompt: string, replies: QuickReply[]): Question {
  return { id: id as Question['id'], field: 'quals', baseValue: 0.9, prompt: () => prompt, quickReplies: () => replies };
}

function build(key: string, ctx: CounselorContext, listings: string[]): Question | null {
  const w = subject(ctx);
  const which = listingReason(listings);
  if (key === 'edu') {
    const f = educationFacts(ctx);
    if (f[1] === 'has') {
      return asQuestion('qual:edu', `${cap(w.p.haveQ)} also completed a college degree? ${which}`, [
        { label: 'No college degree', value: `${w.hasNot} a college degree` },
        { label: 'Associate degree', value: `${w.has} an associate degree` },
        { label: "Bachelor's or higher", value: `${w.has} a bachelor's degree` },
      ]);
    }
    return asQuestion('qual:edu', `What's the highest level of education ${w.s} ${w.p.have} completed? ${which}`, [
      { label: 'No diploma / GED yet', value: `${w.p.Speaker} ${w.p.Speaker === 'I' || w.p.Speaker === 'They' ? "haven't" : "hasn't"} completed a high school diploma or GED` },
      { label: 'High school / GED', value: 'Highest education is high school / GED' },
      { label: 'College degree', value: `${w.has} a college degree` },
      { label: "Bachelor's or higher", value: `${w.has} a bachelor's degree` },
    ]);
  }
  if (key.startsWith('cert:')) {
    const label = certLabel(key.slice(5));
    const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
    return asQuestion(`qual:${key}`, `${cap(w.haveQ)} ${article} ${label}? ${which}`, [
      { label: 'Yes', value: `${w.has} ${article} ${label}` },
      { label: 'Not yet', value: `${w.hasNot} ${article} ${label}` },
      { label: 'Not sure', value: `Not sure about the ${label}` },
    ]);
  }
  if (key.startsWith('exp:')) {
    const area = key === 'exp:supervisory' ? 'supervisory or management' : key === 'exp:any' ? 'paid work' : SECTOR_LABELS[key.slice(4) as Sector]?.toLowerCase() ?? 'related';
    return asQuestion(`qual:${key}`, `How many years of ${area} experience ${w.haveQ}? ${which}`, [
      { label: 'None yet', value: 'None yet' },
      { label: 'Under 2 years', value: 'Under 2 years' },
      { label: '2–4 years', value: '2-4 years' },
      { label: '5+ years', value: '5+ years' },
    ]);
  }
  if (key === 'age') {
    return asQuestion('qual:age', `${w.p.BeQ} 18 or older? ${which}`, [
      { label: '18 or older', value: '18 or older' },
      { label: 'Under 18', value: 'Under 18' },
    ]);
  }
  return null;
}

/**
 * Reads a short reply to a pending qualification question ("Yes", "2-4 years", "Not sure").
 * "Not sure" records nothing — it stays unknown, and the question is not asked again.
 */
export function answerToPending(pending: string | null, message: string): ContextUpdate {
  if (!pending?.startsWith('qual:')) return {};
  const key = pending.slice(5);
  const t = message.trim().toLowerCase();
  if (/\bnot sure|don'?t know|unsure|no idea\b/.test(t)) return {};
  if (key.startsWith('exp:')) {
    const q = extractQuals(message, [], key).quals;
    return Object.keys(q).length ? { quals: q } : {};
  }
  if (key.startsWith('cert:')) {
    if (/\bnot applicable|n\/a|doesn'?t apply\b/.test(t)) return { quals: { [key]: { status: 'not_applicable' } } };
    if (/^(yes|yeah|yep|correct|i do|she does|he does|they do)\b/.test(t)) return { quals: { [key]: { status: 'has' } } };
    if (/^(no|nope|not yet|none)\b/.test(t)) return { quals: { [key]: { status: 'absent' } } };
    return {};
  }
  if (key === 'age') {
    if (/18 or older|over 18|^yes\b|adult/.test(t)) return { quals: { 'age:adult': { status: 'has' } } };
    if (/under 18|^no\b/.test(t)) return { ageBand: 'under_18' };
    return {};
  }
  if (key === 'edu' && /^(no|nope|none)\b/.test(t)) return { quals: { 'edu:associate': { status: 'absent' }, 'edu:bachelor': { status: 'absent' } } };
  return {};
}
