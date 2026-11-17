import { CERTS } from './requirements';
import type { Sector } from './occupations';
import type { QualFact } from '@/types/counselor';

/**
 * Qualification facts from what the user volunteers. Only explicit statements count:
 *   "she has her CNA"            → cert:cna has
 *   "he doesn't have a license"  → cert:drivers_license absent
 *   "she's taking a CNA course"  → cert:cna absent (in progress), currentTraining
 *   "interested in becoming a CNA" → nothing (a goal is not a credential)
 *   "6 years as an electrician"  → exp:skilled_trades {6,6}
 * Anything not stated stays unknown.
 */

const NEG = /\b(no|not|n't|never|without|lost|lacks?|hasn'?t|haven'?t|doesn'?t|don'?t|isn'?t)\b[^.;,]{0,25}$/i;
const IN_PROGRESS = /\b(working on|working toward|studying for|enrolled in|taking|signed up for|in (a|an|the))\b[^.;]{0,25}$/i;
const POSSESS = /\b(has|have|had|got|holds?|earned|completed|passed|finished|with|current|valid|certified|licensed|i'?m an?|she'?s an?|he'?s an?|they'?re|is an?|am an?)\b[^.;]{0,30}$/i;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1 };
const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : WORDS[x.toLowerCase()] ?? NaN);

/** A years-of-experience range in the text, if any. */
export function yearsIn(text: string): { min: number; max: number } | null {
  const t = text.toLowerCase();
  let m = /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:years?|yrs?)/.exec(t);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = /(\d+)\s*\+\s*(?:years?|yrs?)|(\d+|one|two|three|four|five|six|seven|eight|nine|ten) or more years|(?:over|more than) (\d+|one|two|three|four|five|six|seven|eight|nine|ten) years/.exec(t);
  if (m) return { min: num(m[1] ?? m[2] ?? m[3]!), max: 99 };
  if (/less than (a|one) year|under (a|one) year/.test(t)) return { min: 0, max: 0 };
  m = /(?:under|less than) (\d+|two|three|four|five) years?/.exec(t);
  if (m) return { min: 0, max: num(m[1]!) - 1 };
  m = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a) (?:full[- ]time )?(?:years?|yrs?)\b/.exec(t);
  if (m && !/years? old/.test(t.slice(m.index, m.index + 20))) return { min: num(m[1]!), max: num(m[1]!) };
  if (/\ba few years\b/.test(t)) return { min: 2, max: 4 };
  return null;
}

function negated(text: string, index: number) {
  return NEG.test(text.slice(Math.max(0, index - 40), index));
}

export function extractQuals(text: string, sectors: Sector[] = [], pendingExpKey?: string): { quals: Record<string, QualFact>; currentTraining?: string } {
  const quals: Record<string, QualFact> = {};
  let currentTraining: string | undefined;
  const t = text;

  // ── degrees ──
  const degreeNo = /\b(no|without|doesn'?t have|does not have|don'?t have|never (got|earned|finished|completed)|hasn'?t (got|earned|finished|completed))\s+(a |an |any |her |his |their |my )?(college |university |associate'?s? |bachelor'?s? )?degree\b|\bnever went to college\b|\bno college\b|\bno college degree\b/i;
  const highestHs = /\b(highest|only)\b[^.]{0,40}\b(high school|ged|hiset|diploma)\b|\bjust (a |her |his |my )?(high school|ged)\b/i;
  if (degreeNo.test(t) || highestHs.test(t)) {
    quals['edu:associate'] = { status: 'absent' };
    quals['edu:bachelor'] = { status: 'absent' };
    if (highestHs.test(t)) quals['edu:hs'] = { status: 'has' };
  } else {
    const ba = /\b(bachelor'?s|b\.a\.|b\.s\.|four-year degree|graduated (from )?(college|university)|college graduate|university degree|master'?s|graduate degree)\b/i.exec(t);
    const aa = /\b(associate'?s?( degree)?|two-year degree|a\.a\. degree|community college degree)\b/i.exec(t);
    const generic = /\b(has|have|got|earned|completed|with) (a |an |her |his |their |my )?(college )?degree\b|\bcollege degree\b/i.exec(t);
    if (ba && !negated(t, ba.index)) quals['edu:bachelor'] = { status: 'has' };
    else if (aa && !negated(t, aa.index) && !/\b(want|working (on|toward)|studying)\b/i.test(t.slice(Math.max(0, aa.index - 30), aa.index))) quals['edu:associate'] = { status: 'has' };
    else if (generic && !negated(t, generic.index)) quals['edu:associate'] = { status: 'has' };
  }

  // ── certifications and licenses ──
  for (const c of CERTS) {
    const m = c.re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, m.index - 45), m.index);
    // The credential named in a goal ("wants to become a CNA") is not held.
    if (/\b(want|wants|become|becoming|interested in|hoping to|plans? to|would like)\b[^.]{0,30}$/i.test(before)) continue;
    if (IN_PROGRESS.test(before)) {
      quals[`cert:${c.slug}`] = { status: 'absent' };
      currentTraining = c.label;
    } else if (NEG.test(before) || /\b(not|isn'?t) (certified|licensed)\b/i.test(t)) quals[`cert:${c.slug}`] = { status: 'absent' };
    else if (/\bnot applicable|n\/a|doesn'?t apply\b/i.test(t)) quals[`cert:${c.slug}`] = { status: 'not_applicable' };
    else if (POSSESS.test(before) || /^\s*(yes|yep|yeah)\b/i.test(t)) quals[`cert:${c.slug}`] = { status: 'has' };
  }
  if (/\b(can'?t|cannot|doesn'?t|does not|don'?t) drive\b|\bsuspended (driver'?s )?licen[cs]e\b/i.test(t)) quals['cert:drivers_license'] = { status: 'absent' };
  if (/\blicensed driver\b/i.test(t)) quals['cert:drivers_license'] = { status: 'has' };

  // ── experience ──
  const none = /\b(no (work |job |prior |previous |relevant |paid )?experience|never (had a job|worked)|first job|none yet)\b/i.test(t);
  const years = yearsIn(t);
  const supervisory = /\bsupervis|\bmanag(?:ed|er|ing|ement)|\blead\b|\bled (a|the)\b|\bforeman\b/i.test(t);
  const keys = pendingExpKey ? [pendingExpKey] : sectors.map((s) => `exp:${s}`);
  if (none) {
    if (keys.length) for (const k of keys) quals[k] = { status: 'absent' };
    else quals['exp:any'] = { status: 'absent' };
  } else if (years) {
    for (const k of keys) quals[k] = { status: years.max === 0 ? 'absent' : 'has', years };
    if (supervisory && !pendingExpKey) quals['exp:supervisory'] = { status: 'has', years };
  } else if (keys.length && /\b(worked|experience|years|as an?|background)\b/i.test(t) && !pendingExpKey) {
    for (const k of keys) quals[k] ??= { status: 'has' };
  }
  if (/\b(in|taking|enrolled in|attending)\s+(a |an )?([a-z ]{3,30}) (course|program|class(es)?|training)\b/i.test(t) && !currentTraining) {
    currentTraining = /\b(?:in|taking|enrolled in|attending)\s+(?:a |an )?([a-z ]{3,30} (?:course|program|class(?:es)?|training))\b/i.exec(t)?.[1];
  }
  return { quals, currentTraining };
}
