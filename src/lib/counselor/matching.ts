import { RuleField, RuleOperator } from '@prisma/client';
import { prisma } from '../db';
import type {
  Assumption,
  CounselorContext,
  KnownFact,
  MatchState,
  NarrowingState,
  ProgramMatch,
} from '@/types/counselor';
import { POPULATION_LABELS } from '@/types/counselor';
import { criteriaFor } from './questions';

/**
 * Progressive program matching.
 *
 * The rule from the brief that shapes everything here: **absence of evidence
 * is not exclusion**. A program leaves the candidate set only when a verified,
 * published rule is definitively contradicted. Anything we cannot test stays
 * in, marked `needs_verification`, because a real counselor would say "worth
 * asking about" rather than silently dropping it.
 *
 * Similarity scores never decide eligibility. Retrieval finds text; these
 * structured rules decide who may qualify.
 */

export type ProgramRow = Awaited<ReturnType<typeof loadPrograms>>[number];

export async function loadPrograms() {
  return prisma.program.findMany({
    where: { status: 'ACTIVE' },
    include: { category: true, serviceAreas: true, rules: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/** The real catalogue size — never a fabricated total. */
export async function totalProgramCount(): Promise<number> {
  return prisma.program.count({ where: { status: 'ACTIVE' } });
}

function ageFrom(ctx: CounselorContext): number | undefined {
  if (typeof ctx.age === 'number') return ctx.age;
  switch (ctx.ageBand) {
    case 'under_18': return 17;
    case '18_24': return 21;
    case '25_54': return 40;
    case '55_plus': return 60;
    default: return undefined;
  }
}

function resolveField(field: RuleField, ctx: CounselorContext): string | number | boolean | undefined {
  switch (field) {
    case RuleField.COUNTY: return ctx.county;
    case RuleField.EMPLOYMENT_STATUS: return ctx.employmentStatus;
    case RuleField.AGE: return ageFrom(ctx);
    case RuleField.VETERAN_STATUS: return ctx.population.includes('veteran') ? true : undefined;
    case RuleField.DISABILITY_STATUS: return ctx.population.includes('disability') ? true : undefined;
    case RuleField.AUDIENCE: return ctx.audience;
    // Income and education level are never asserted from conversation alone.
    case RuleField.INCOME_LEVEL:
    case RuleField.EDUCATION_LEVEL:
    case RuleField.OTHER:
    default:
      return undefined;
  }
}

function applyOperator(op: RuleOperator, actual: string | number | boolean, expected: unknown): boolean | null {
  const norm = (v: unknown) => String(v).trim().toLowerCase();
  switch (op) {
    case RuleOperator.IN: return Array.isArray(expected) ? expected.map(norm).includes(norm(actual)) : null;
    case RuleOperator.NOT_IN: return Array.isArray(expected) ? !expected.map(norm).includes(norm(actual)) : null;
    case RuleOperator.EQUALS: return norm(actual) === norm(expected);
    case RuleOperator.GTE: return typeof actual === 'number' && typeof expected === 'number' ? actual >= expected : null;
    case RuleOperator.LTE: return typeof actual === 'number' && typeof expected === 'number' ? actual <= expected : null;
    case RuleOperator.BETWEEN: {
      if (typeof actual !== 'number' || !Array.isArray(expected) || expected.length !== 2) return null;
      const [lo, hi] = expected as [unknown, unknown];
      if (typeof lo !== 'number' || typeof hi !== 'number') return null;
      return actual >= lo && actual <= hi;
    }
    case RuleOperator.EXISTS: return actual !== undefined && actual !== null && actual !== '';
    default: return null;
  }
}

export function matchPrograms(programs: ProgramRow[], ctx: CounselorContext): ProgramMatch[] {
  return programs.map((p) => {
    const reasons: string[] = [];
    const openQuestions: string[] = [];
    let state: MatchState = 'needs_verification';
    let contradicted = false;
    let confirmed = 0;

    // ── Geography: the one hard constraint we can apply confidently ──
    if (ctx.county && p.serviceAreas.length > 0) {
      const serves = p.serviceAreas.some((a) => a.county === ctx.county);
      if (serves) {
        reasons.push(`Available in ${ctx.county} County`);
        confirmed++;
      } else {
        contradicted = true;
        openQuestions.push(`Not listed for ${ctx.county} County`);
      }
    }

    // ── Audience ──
    if (ctx.audience && p.audience !== 'both' && p.audience !== ctx.audience) {
      contradicted = true;
      openQuestions.push(
        ctx.audience === 'employer' ? 'This is a job seeker service' : 'This is an employer service',
      );
    }

    // ── Published eligibility rules ──
    for (const rule of p.rules) {
      if (!rule.verified) {
        openQuestions.push(rule.description);
        continue;
      }
      const actual = resolveField(rule.field, ctx);
      if (actual === undefined) {
        openQuestions.push(rule.description);
        continue;
      }
      const ok = applyOperator(rule.operator, actual, rule.value);
      if (ok === null) {
        openQuestions.push(rule.description);
      } else if (ok) {
        confirmed++;
        reasons.push(rule.description);
      } else if (rule.hard) {
        contradicted = true;
        openQuestions.push(`Does not meet: ${rule.description}`);
      } else {
        // Soft rules lower confidence; they never exclude.
        openQuestions.push(`May not meet: ${rule.description}`);
      }
    }

    // ── Soft signals that keep a program relevant ──
    const hay = `${p.name} ${p.shortDescription} ${p.keywords.join(' ')}`.toLowerCase();
    if (ctx.careerInterest && hay.includes(ctx.careerInterest.toLowerCase())) {
      reasons.push(`Connects to ${ctx.careerInterest}`);
    }
    if (ctx.population.includes('veteran') && /veteran/i.test(hay)) {
      reasons.push('Veterans receive priority of service');
    }
    if (ctx.incomeUrgency === 'immediate' && /job-search|hiring|recruitment/i.test(p.slug)) {
      reasons.push('Leads to work sooner');
    }
    if (ctx.incomeUrgency === 'can_train_first' && /training|scholarship|metrix|internship/i.test(p.slug)) {
      reasons.push('Suits focusing on training first');
    }
    if (ctx.transportation === 'none' && p.serviceAreas.length > 1) {
      openQuestions.push('Check whether a local site or remote option is available');
    }
    if (ctx.education === 'no_hs_diploma' || ctx.education === 'working_on_ged') {
      if (/training|scholarship/i.test(p.slug)) {
        openQuestions.push('Confirm whether a diploma or GED is required first');
      }
    }

    if (contradicted) state = 'mismatch';
    else if (openQuestions.length === 0 && confirmed > 0) state = 'eligible';
    else if (confirmed > 0) state = 'potential';
    else state = 'needs_verification';

    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      shortDescription: p.shortDescription,
      state,
      reasons: [...new Set(reasons)],
      openQuestions: [...new Set(openQuestions)].slice(0, 4),
      officialUrl: p.officialUrl,
      contactPhone: p.contactPhone,
      nextSteps: p.nextSteps,
      counties: p.serviceAreas.map((a) => a.county),
      category: p.category?.name ?? null,
    };
  });
}

/**
 * A program's verdict under its *published* requirements only: each verified rule with a source
 * (pass / fail / unknown), its service area, and its audience. Heuristic signals are excluded, so
 * question selection is driven by what programs actually require.
 */
export function requirementVerdicts(p: ProgramRow, ctx: CounselorContext): string {
  const parts: string[] = [];
  if (p.serviceAreas.length) parts.push(`area:${ctx.county ? p.serviceAreas.some((a) => a.county === ctx.county) : '?'}`);
  if (p.audience !== 'both') parts.push(`aud:${ctx.audience ? ctx.audience === p.audience : '?'}`);
  for (const rule of p.rules) {
    if (!rule.verified || !rule.sourceUrl) continue;
    const actual = resolveField(rule.field, ctx);
    const ok = actual === undefined ? null : applyOperator(rule.operator, actual, rule.value);
    parts.push(`${rule.field}:${ok === null ? '?' : ok}`);
  }
  return `${p.slug}[${parts.join(',')}]`;
}

/** Most promising first; mismatches drop out entirely. */
export function rankMatches(matches: ProgramMatch[]): ProgramMatch[] {
  const weight: Record<MatchState, number> = {
    eligible: 3,
    potential: 2,
    needs_verification: 1,
    mismatch: 0,
  };
  return matches
    .filter((m) => m.state !== 'mismatch')
    .sort((a, b) => weight[b.state] - weight[a.state] || b.reasons.length - a.reasons.length);
}

export function buildNarrowing(
  ctx: CounselorContext,
  matches: ProgramMatch[],
  total: number | null,
): NarrowingState {
  const live = matches.filter((m) => m.state !== 'mismatch').length;
  const criteria = criteriaFor(ctx);
  const applied = criteria.filter((c) => c.applied).length;

  // Honest about what the number means — and null rather than invented.
  let explanation: string;
  if (total === null || total === 0) {
    explanation = 'Searching available workforce resources';
  } else if (applied === 0) {
    explanation = `All ${total} services are in play — tell me a little and I'll narrow it`;
  } else if (live === total) {
    explanation = `Still ${live} — nothing ruled out yet`;
  } else {
    explanation = `Narrowed from ${total} using ${applied} thing${applied === 1 ? '' : 's'} you told me`;
  }

  return {
    candidates: total === null ? null : live,
    total,
    criteria,
    explanation,
  };
}

export function buildKnownFacts(ctx: CounselorContext, pendingLabel?: string): KnownFact[] {
  const facts: KnownFact[] = [];
  const add = (key: string, label: string, dimension: string, inferred = false) =>
    facts.push({ key, label, dimension, state: 'known', inferred });

  for (const tag of ctx.population) add(tag, POPULATION_LABELS[tag], 'Population');
  if (ctx.careerInterest) add('careerInterest', titleCase(ctx.careerInterest), 'Career pathway');

  if (ctx.education && ctx.education !== 'unknown') {
    add('education', EDUCATION_LABELS[ctx.education] ?? ctx.education, 'Service type');
  }

  const place = [ctx.city ? titleCase(ctx.city) : null, ctx.county ? `${ctx.county} County` : null]
    .filter(Boolean)
    .join(', ');
  const transport = ctx.transportation && ctx.transportation !== 'unknown'
    ? (TRANSPORT_LABELS[ctx.transportation] ?? '')
    : null;
  if (place || transport) {
    add('geography', [place, transport].filter(Boolean).join(' — '), 'Geography');
  }

  if (ctx.incomeUrgency && ctx.incomeUrgency !== 'unknown') {
    add('incomeUrgency', INCOME_LABELS[ctx.incomeUrgency] ?? '', 'Timing');
  }
  if (ctx.employmentStatus) {
    add('employmentStatus', titleCase(ctx.employmentStatus.replace(/_/g, ' ')), 'Situation');
  }
  if (typeof ctx.age === 'number') add('age', `${ctx.age} years old`, 'Age');
  else if (ctx.ageBand) add('age', AGE_LABELS[ctx.ageBand] ?? ctx.ageBand, 'Age', true);

  if (pendingLabel) {
    facts.push({ key: 'pending', label: pendingLabel, dimension: 'Waiting on answer', state: 'pending' });
  }
  return facts;
}

/**
 * Interpretations the engine is relying on. Kept internal — the UI no longer
 * shows them as a separate notice; eligibility caveats appear on each
 * recommendation instead.
 */
export function buildAssumptions(ctx: CounselorContext, matches: ProgramMatch[]): Assumption | null {
  if (ctx.population.includes('former_foster_youth') && (ctx.age ?? 99) <= 24) {
    return {
      id: 'foster_youth',
      text: `${ctx.mode === 'helper' ? 'They' : 'You'} may qualify for youth-focused services based on age and background, though each program confirms eligibility separately.`,
      basis: 'Age and former foster youth status',
    };
  }
  if (ctx.transportation === 'none' && ctx.county) {
    return {
      id: 'transport',
      text: `I'm prioritising ${ctx.city ? titleCase(ctx.city) : ctx.county}-area options and flagging anything that would need travel.`,
      basis: 'No reliable transport',
    };
  }
  if (ctx.education === 'no_hs_diploma' || ctx.education === 'working_on_ged') {
    return {
      id: 'ged',
      text: 'I\'m treating a diploma or GED as still in progress, so I\'ll flag training that expects one up front.',
      basis: 'Education status',
    };
  }
  const needsVerify = matches.filter((m) => m.state === 'needs_verification').length;
  if (needsVerify > 0 && matches.length > 0 && needsVerify === matches.length) {
    return {
      id: 'unverified',
      text: 'Nothing here is ruled out yet — I just don\'t have enough to confirm eligibility, so staff would need to check.',
      basis: 'No eligibility rules tested yet',
    };
  }
  return null;
}

const EDUCATION_LABELS: Record<string, string> = {
  no_hs_diploma: 'Needs GED / HiSET',
  working_on_ged: 'Working toward GED',
  ged_or_hs: 'GED or diploma complete',
  some_college: 'Some college',
  degree: 'Degree',
  unknown: 'Unknown',
};
const TRANSPORT_LABELS: Record<string, string> = {
  own_vehicle: 'has a vehicle',
  transit_only: 'transit only',
  none: 'no transport',
  unknown: '',
};
const INCOME_LABELS: Record<string, string> = {
  immediate: 'Needs income soon',
  can_train_first: 'Can train first',
  flexible: 'Open to either',
  unknown: '',
};
const AGE_LABELS: Record<string, string> = {
  under_18: 'Under 18',
  '18_24': '18–24',
  '25_54': '25–54',
  '55_plus': '55+',
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
