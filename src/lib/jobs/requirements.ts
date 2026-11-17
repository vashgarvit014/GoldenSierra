import { OCCUPATION_BY_KEY, SECTOR_LABELS, type Sector } from './occupations';
import { SUBJECT, type CounselorContext, type QualFact } from '@/types/counselor';
import type { JobRequirement, QualificationSummary } from '@/types/navigator';

/**
 * Published job requirements, parsed from the listing's own verbatim text, and compared with what the
 * user has said. Three outcomes only — met, unmet, unknown — and missing information is always
 * "unknown", never "unmet". Occupational similarity is never treated as meeting an experience
 * requirement: a solar installer is not "5 years as an electrician" unless they say so.
 *
 * Structure of a requirement text:  "A + B; OR C; D (preferred)"
 *   ';'  separates requirements          'OR' starts an alternative of the previous one
 *   '+'  joins atoms that must all hold  'preferred' / 'desirable' → not mandatory
 *   'or equivalent …' / 'may substitute' → the atom can be satisfied another way (never "unmet" alone)
 */

// ───────────────────────── certification / license vocabulary ─────────────────────────

export const CERTS: { slug: string; label: string; re: RegExp }[] = [
  { slug: 'drivers_license', label: "driver's license", re: /\b(driver'?s|driving) licen[cs]e\b|\bclass c\b/i },
  { slug: 'cdl', label: 'commercial driver’s license (CDL)', re: /\bcdl\b|commercial driver'?s licen[cs]e/i },
  { slug: 'cna', label: 'CNA certification', re: /\bcna\b|certified nursing assistant|nursing assistant (certificat|licen)/i },
  { slug: 'hha', label: 'home health aide certification', re: /home health aide (certificat|licen)|\bhha\b/i },
  { slug: 'cpr', label: 'CPR / first aid', re: /\bcpr\b|first aid/i },
  { slug: 'phlebotomy', label: 'phlebotomy certification', re: /phlebotomy (certificat|technician)|\bcpt[- ]?1\b/i },
  { slug: 'cma', label: 'medical assistant certification', re: /certified medical assistant|\bcma\b|medical assistant certificat/i },
  { slug: 'imsa', label: 'IMSA traffic signal certification', re: /\bimsa\b/i },
  { slug: 'work_zone', label: 'work zone traffic control safety certificate', re: /work zone (traffic control )?safety/i },
  { slug: 'forklift', label: 'forklift certification', re: /forklift (certificat|licen|certified)|certified forklift/i },
  { slug: 'food_handler', label: 'food handler card', re: /food handler|servsafe/i },
  { slug: 'osha', label: 'OSHA safety card', re: /\bosha[- ]?(10|30)?\b/i },
  { slug: 'nabcep', label: 'NABCEP solar certification', re: /\bnabcep\b/i },
  { slug: 'epa608', label: 'EPA 608 certification', re: /\bepa (section )?608\b/i },
  { slug: 'electrician_cert', label: 'electrician certification', re: /(state |ca )?(general )?electrician certificat|journeyman (card|licen)|certified electrician/i },
  { slug: 'comptia', label: 'CompTIA certification', re: /comptia|\ba\+ certif|network\+|security\+/i },
  { slug: 'sales_license', label: 'state sales license', re: /\bsales licen[cs]e|salesperson licen[cs]e/i },
  { slug: 'crisis_training', label: 'crisis-intervention training', re: /crisis[- ]intervention training/i },
];

export const certLabel = (slug: string) => CERTS.find((c) => c.slug === slug)?.label ?? slug.replace(/_/g, ' ');

// ───────────────────────── parsing ─────────────────────────

export type EduLevel = 1 | 2 | 3; // 1 high school / GED, 2 associate / college degree, 3 bachelor's
const EDU_LABEL: Record<EduLevel, string> = { 1: 'a high school diploma or equivalent', 2: "an associate's / college degree", 3: "a bachelor's degree" };

export type Atom =
  | { kind: 'education'; level: EduLevel; text: string; substitutable: boolean }
  | { kind: 'experience'; years: number | null; supervisory: boolean; text: string; substitutable: boolean }
  | { kind: 'credential'; slug: string; text: string }
  | { kind: 'age'; min: number; text: string }
  | { kind: 'other'; text: string };

export type ParsedRequirement = { text: string; mandatory: boolean; alternatives: Atom[][]; informational: boolean; field: 'qualifications' | 'requiredSkills' };

function atomsOf(part: string): Atom[] {
  const out: Atom[] = [];
  const substitutable = /or equivalent|may substitute|equivalent combination/i.test(part);
  // The substitution clause itself ("(or equivalent experience/certs)") is not a separate requirement.
  const t = part.toLowerCase().replace(/\(?\s*,?\s*or equivalent[^;)]*\)?/g, ' ').replace(/equivalent combination of [^;]*/g, ' ');
  if (/\bbachelor'?s\b|four-year degree/.test(t)) out.push({ kind: 'education', level: 3, text: part, substitutable });
  else if (/\bassociate'?s\b|semester units|two-year degree|college degree|\bdegree\b/.test(t)) out.push({ kind: 'education', level: 2, text: part, substitutable });
  // "HS diploma or equivalent" means GED/HiSET — not a way around the requirement.
  else if (/\b(hs diploma|high school|12th grade|ged)\b/.test(t)) out.push({ kind: 'education', level: 1, text: part, substitutable: substitutable && !/(diploma|high school|12th grade)\)?\s*,?\s*or equivalent\s*$/i.test(part.trim()) });
  const years = /(\d+)\s*(?:\+|-\s*\d+)?\s*-?\s*(?:yrs?|years?)\b(?![^;]*\bof age)/.exec(t);
  if (/\bexperience\b|\bapprenticeship\b/.test(t) || (years && !/age/.test(t))) {
    out.push({ kind: 'experience', years: years ? Number(years[1]) : null, supervisory: /supervis|management|manager|lead\b/.test(t), text: part, substitutable });
  }
  for (const c of CERTS) if (c.re.test(part)) out.push({ kind: 'credential', slug: c.slug, text: part });
  const age = /minimum age (\d+)|(\d+) years? (?:of age|or older)/.exec(t);
  if (age) out.push({ kind: 'age', min: Number(age[1] ?? age[2]), text: part });
  return out.length ? out : [{ kind: 'other', text: part }];
}

/** Requirements from the qualifications column, plus credentials named in the "required skills" column. */
export function parseRequirements(qualifications: string | null, requiredSkills: string | null): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  const parts = (qualifications ?? '').split(/;\s*/).map((x) => x.trim()).filter(Boolean);
  for (const raw of parts) {
    if (/^no formal eligibility/i.test(raw)) continue;
    const informational = /provided after hire|after hire|will be provided|on the job training provided/i.test(raw);
    // "may substitute" qualifies the previous requirement; it is not a requirement of its own.
    if (/may substitute/i.test(raw) && out.length) {
      for (const atom of out.at(-1)!.alternatives.flat()) if (atom.kind === 'experience' || atom.kind === 'education') atom.substitutable = true;
      out.at(-1)!.text += `; ${raw}`;
      continue;
    }
    // "(education setting preferred)" refines a requirement; only an unbracketed "preferred" makes it optional.
    const bare = raw.replace(/\([^)]*\)/g, '');
    const mandatory = !/\b(preferred|desirable|a plus|nice to have)\b/i.test(bare) && !/^may need\b/i.test(raw);
    const alts = raw.replace(/^multiple qualifying paths:\s*/i, '').split(/,?\s+\bOR\b\s+/).map((a) => a.split(/\s\+\s|\s&\s/).flatMap(atomsOf));
    if (/^or\s/i.test(raw) && out.length) {
      // "…; OR Associate's degree + school experience" is another way to meet the previous requirement.
      out.at(-1)!.alternatives.push(raw.replace(/^or\s+/i, '').split(/\s\+\s|\s&\s/).flatMap(atomsOf));
      out.at(-1)!.text += `; ${raw}`;
      continue;
    }
    out.push({ text: raw, mandatory, alternatives: alts, informational, field: 'qualifications' });
  }
  // Credentials listed as required skills (e.g. "IMSA certification, CA Class C driver's license").
  for (const piece of (requiredSkills ?? '').split(/[,;]\s*/)) {
    const c = CERTS.find((x) => x.re.test(piece));
    if (c && /certif|licen[cs]e|card/i.test(piece) && !out.some((r) => r.alternatives.flat().some((a) => a.kind === 'credential' && a.slug === c.slug))) {
      out.push({ text: piece.trim(), mandatory: true, alternatives: [[{ kind: 'credential', slug: c.slug, text: piece.trim() }]], informational: false, field: 'requiredSkills' });
    }
  }
  return out;
}

// ───────────────────────── what the user has said ─────────────────────────

const RANK: Record<string, number> = { no_hs_diploma: 0, working_on_ged: 0, ged_or_hs: 1, some_college: 1, degree: 2 };

/** Education level evidence: for each level, 'has' | 'absent' | undefined (unknown). */
export function educationFacts(ctx: CounselorContext): Record<EduLevel, 'has' | 'absent' | undefined> {
  const f: Record<EduLevel, 'has' | 'absent' | undefined> = { 1: undefined, 2: undefined, 3: undefined };
  if (ctx.education && ctx.education in RANK) {
    const r = RANK[ctx.education]!;
    if (r === 0) f[1] = f[2] = f[3] = 'absent'; // no diploma: no degree either
    if (r >= 1) f[1] = 'has';
    if (r >= 2) f[2] = 'has';
  }
  const q = ctx.quals ?? {};
  const set = (lvl: EduLevel, key: string) => {
    const v = q[key]?.status;
    if (v === 'has') for (let l = 1; l <= lvl; l++) f[l as EduLevel] = 'has';
    if (v === 'absent') f[lvl] = 'absent';
  };
  set(1, 'edu:hs');
  set(2, 'edu:associate');
  set(3, 'edu:bachelor');
  // "No college degree" covers bachelor's too.
  if (q['edu:associate']?.status === 'absent' && q['edu:bachelor']?.status !== 'has') f[3] = 'absent';
  return f;
}

function eduMet(level: EduLevel, ctx: CounselorContext): 'met' | 'unmet' | 'unknown' {
  const f = educationFacts(ctx);
  for (let l = level; l <= 3; l++) if (f[l as EduLevel] === 'has') return 'met';
  for (let l = level; l <= 3; l++) if (f[l as EduLevel] !== 'absent') return 'unknown';
  return 'unmet';
}

function expFact(ctx: CounselorContext, sector: Sector | null, supervisory: boolean): QualFact | undefined {
  const q = ctx.quals ?? {};
  return supervisory ? q['exp:supervisory'] : sector ? q[`exp:${sector}`] : undefined;
}

/** Their stated relevant experience in this listing's line of work (never a related field). */
function expMet(atom: Extract<Atom, { kind: 'experience' }>, ctx: CounselorContext, sector: Sector | null): 'met' | 'unmet' | 'unknown' {
  const q = ctx.quals ?? {};
  const fact = expFact(ctx, sector, atom.supervisory);
  if (q['exp:any']?.status === 'absent') return atom.substitutable ? 'unknown' : 'unmet';
  if (!fact) return 'unknown';
  if (fact.status === 'absent') return atom.substitutable ? 'unknown' : 'unmet';
  if (fact.status !== 'has') return 'unknown';
  if (atom.years == null) return 'met';
  if (!fact.years) return 'unknown';
  if (fact.years.min >= atom.years) return 'met';
  if (fact.years.max < atom.years) return atom.substitutable ? 'unknown' : 'unmet';
  return 'unknown';
}

function atomStatus(a: Atom, ctx: CounselorContext, sector: Sector | null): 'met' | 'unmet' | 'unknown' {
  switch (a.kind) {
    case 'education': {
      const s = eduMet(a.level, ctx);
      return s === 'unmet' && a.substitutable ? 'unknown' : s;
    }
    case 'experience':
      return expMet(a, ctx, sector);
    case 'credential': {
      const f = ctx.quals?.[`cert:${a.slug}`];
      return f?.status === 'has' ? 'met' : f?.status === 'absent' ? 'unmet' : 'unknown';
    }
    case 'age':
      if (ctx.age != null) return ctx.age >= a.min ? 'met' : 'unmet';
      if (a.min <= 18 && (ctx.quals?.['age:adult']?.status === 'has' || (ctx.ageBand && ctx.ageBand !== 'under_18'))) return 'met';
      return ctx.ageBand === 'under_18' && a.min >= 18 ? 'unmet' : 'unknown';
    default:
      return 'unknown';
  }
}

const combineAll = (xs: ('met' | 'unmet' | 'unknown')[]) => (xs.includes('unmet') ? 'unmet' : xs.every((x) => x === 'met') ? 'met' : 'unknown');
const combineAny = (xs: ('met' | 'unmet' | 'unknown')[]) => (xs.includes('met') ? 'met' : xs.every((x) => x === 'unmet') ? 'unmet' : 'unknown');

/** What the user has told us that bears on this requirement, in plain words. */
function comparisonText(r: ParsedRequirement, ctx: CounselorContext, sector: Sector | null): string {
  const s = SUBJECT[ctx.mode];
  const said: string[] = [];
  const atoms = r.alternatives.flat();
  if (atoms.some((a) => a.kind === 'education')) {
    const f = educationFacts(ctx);
    const top = f[3] === 'has' ? "bachelor's degree" : f[2] === 'has' ? 'college degree' : f[1] === 'has' ? 'high school diploma / GED' : f[1] === 'absent' ? 'no high school diploma or GED yet' : null;
    said.push(top ? `Education: ${top}${f[2] === 'absent' && f[1] === 'has' ? ', no college degree' : ''}` : 'Education: not shared yet');
  }
  for (const a of atoms) {
    if (a.kind === 'experience') {
      const fact = expFact(ctx, sector, a.supervisory);
      const area = a.supervisory ? 'supervisory' : sector ? SECTOR_LABELS[sector].toLowerCase() : 'relevant';
      if (ctx.quals?.['exp:any']?.status === 'absent') said.push('Experience: none yet (stated)');
      else if (fact?.status === 'has') said.push(`Experience (${area}): ${fact.years ? (fact.years.max >= 50 ? `${fact.years.min}+ years` : fact.years.min === fact.years.max ? `${fact.years.min} years` : `${fact.years.min}–${fact.years.max} years`) : 'yes, years not stated'}`);
      else if (fact?.status === 'absent') said.push(`Experience (${area}): none (stated)`);
      else {
        const related = [...(ctx.experience ?? [])].map((k) => OCCUPATION_BY_KEY.get(k)?.title.toLowerCase()).filter(Boolean);
        said.push(related.length ? `Experience: ${related.join(', ')} — may or may not count; the employer decides` : `Experience (${area}): not shared yet`);
      }
    }
    if (a.kind === 'credential') {
      const f = ctx.quals?.[`cert:${a.slug}`];
      said.push(`${certLabel(a.slug)}: ${f?.status === 'has' ? 'yes (stated)' : f?.status === 'absent' ? 'no (stated)' : f?.status === 'not_applicable' ? 'not applicable' : 'not shared yet'}`);
    }
    if (a.kind === 'age') said.push(`Age: ${ctx.age ?? (ctx.ageBand ? ctx.ageBand.replace('_', '–') : 'not shared yet')}`);
  }
  const uniq = [...new Set(said)];
  return uniq.length ? `${s.possessive[0]!.toUpperCase()}${s.possessive.slice(1)} information — ${uniq.join('; ')}` : 'Nothing to compare yet';
}

/** Facts whose answer would decide this requirement (for targeted questions). */
export function decidingFacts(r: ParsedRequirement, sector: Sector | null, ctx?: CounselorContext): string[] {
  const keys = new Set<string>();
  // Only facts still unknown can decide it: "no bachelor's" already settles that alternative.
  // The underlying fact must be unknown — a degree known to be absent stays "unknown" only because it can be
  // substituted, and asking about education again would not change that.
  const factUnknown = (x: Atom) =>
    !ctx || (x.kind === 'education' ? eduMet(x.level, ctx) === 'unknown' : x.kind === 'experience' ? expMet({ ...x, substitutable: false }, ctx, sector) === 'unknown' : atomStatus(x, ctx, sector) === 'unknown');
  for (const a of r.alternatives.flat().filter(factUnknown)) {
    if (a.kind === 'education') keys.add('edu');
    if (a.kind === 'experience') keys.add(a.supervisory ? 'exp:supervisory' : sector ? `exp:${sector}` : 'exp:any');
    if (a.kind === 'credential') keys.add(`cert:${a.slug}`);
    if (a.kind === 'age') keys.add('age');
  }
  return [...keys];
}

export function evaluateRequirements(
  l: { qualifications: string | null; requiredSkills: string | null },
  ctx: CounselorContext,
  sector: Sector | null,
  sourceFor: (text: string) => { chunkIds: string[] },
): { requirements: JobRequirement[]; summary: QualificationSummary } {
  const parsed = parseRequirements(l.qualifications, l.requiredSkills);
  const requirements: JobRequirement[] = parsed.map((r) => {
    const status = r.informational ? 'met' : combineAny(r.alternatives.map((alt) => combineAll(alt.map((a) => atomStatus(a, ctx, sector)))));
    const kinds = [...new Set(r.alternatives.flat().map((a) => a.kind))];
    const edu = r.alternatives.flat().find((a) => a.kind === 'education') as Extract<Atom, { kind: 'education' }> | undefined;
    return {
      text: r.text,
      about: kinds.length === 1 ? (kinds[0] === 'credential' ? 'certification' : kinds[0]!) : kinds.includes('education') ? 'education' : kinds.includes('experience') ? 'experience' : 'other',
      mandatory: r.mandatory && !r.informational,
      informational: r.informational,
      alternatives: r.alternatives.length > 1 ? r.alternatives.length : undefined,
      status: r.informational ? 'met' : status,
      comparison: r.informational ? 'Not a prerequisite — the listing says it is provided after hire' : comparisonText(r, ctx, sector),
      educationLevel: edu ? EDU_LABEL[edu.level] : undefined,
      decidedBy: r.informational ? [] : decidingFacts(r, sector, ctx),
      source: { field: r.field, ...sourceFor(r.text) },
    } as JobRequirement;
  });
  const mandatory = requirements.filter((r) => r.mandatory);
  const summary: QualificationSummary = {
    published: requirements.length,
    mandatory: mandatory.length,
    met: mandatory.filter((r) => r.status === 'met').length,
    unmet: mandatory.filter((r) => r.status === 'unmet').length,
    unknown: mandatory.filter((r) => r.status === 'unknown').length,
    missing: mandatory.filter((r) => r.status === 'unmet').map((r) => r.text),
    // "Requirements met" is only ever said when every mandatory requirement was checked against stated facts.
    fit: mandatory.length === 0 ? 'no_published_requirements' : mandatory.some((r) => r.status === 'unmet') ? 'gaps' : mandatory.every((r) => r.status === 'met') ? 'meets_published' : 'incomplete',
  };
  return { requirements, summary };
}
