import { RuleField, RuleOperator } from '@prisma/client';
import type { UserProfile } from '@/types/chat';
import type { ProgramRecord } from '../rag/retrieve';

/**
 * Deterministic eligibility evaluation.
 *
 * The division of labour here is the point of the whole module: *code* decides
 * whether a stated rule is met, and the language model only explains the
 * result in plain English. The model is never asked to judge eligibility,
 * because an approval it invents is indistinguishable from a real one to the
 * person reading it.
 *
 * Three outcomes, and the difference between them is load-bearing:
 *
 *   - `met`     — a verified published rule, and the user's stated facts satisfy it.
 *   - `unmet`   — a verified published rule, and the user's stated facts contradict it.
 *   - `unknown` — we have no stated fact to test, or the rule itself is unverified.
 *
 * `unknown` is the common case and must never be presented as either approval
 * or rejection. Only agency staff confirm eligibility.
 */

export type RuleEvaluation = {
  ruleId: string;
  field: RuleField;
  description: string;
  outcome: 'met' | 'unmet' | 'unknown';
  hard: boolean;
  verified: boolean;
  sourceUrl: string | null;
  /** Why we reached this outcome — surfaced in the admin test console. */
  reason: string;
};

export type EligibilityAssessment = {
  /** False only when a HARD, VERIFIED rule is definitively contradicted. */
  possiblyEligible: boolean;
  evaluations: RuleEvaluation[];
  /** Verified rules the user's stated facts satisfy. */
  met: RuleEvaluation[];
  /** Verified hard rules the user's stated facts contradict. */
  exclusions: RuleEvaluation[];
  /** Rules we could not test — the basis for "staff will confirm". */
  unknowns: RuleEvaluation[];
  /** True when nothing could be confirmed and staff must verify. */
  requiresVerification: boolean;
};

export function evaluateProgram(program: ProgramRecord, profile: UserProfile): EligibilityAssessment {
  const evaluations = program.rules.map((rule) => evaluateRule(rule, profile, program));

  const met = evaluations.filter((e) => e.outcome === 'met' && e.verified);
  const exclusions = evaluations.filter((e) => e.outcome === 'unmet' && e.hard && e.verified);
  const unknowns = evaluations.filter((e) => e.outcome === 'unknown');

  return {
    possiblyEligible: exclusions.length === 0,
    evaluations,
    met,
    exclusions,
    unknowns,
    // Staff confirmation is required unless every rule is verified and met —
    // and even then the program itself may demand it.
    requiresVerification:
      program.requiresVerification || unknowns.length > 0 || met.length < program.rules.length,
  };
}

function evaluateRule(
  rule: ProgramRecord['rules'][number],
  profile: UserProfile,
  program: ProgramRecord,
): RuleEvaluation {
  const base = {
    ruleId: rule.id,
    field: rule.field,
    description: rule.description,
    hard: rule.hard,
    verified: rule.verified,
    sourceUrl: rule.sourceUrl,
  };

  // An unverified rule never decides anything. It can still be shown as
  // "something to confirm", but it cannot exclude anyone.
  if (!rule.verified) {
    return { ...base, outcome: 'unknown', reason: 'Rule has not been verified against a published source' };
  }

  const actual = resolveField(rule.field, profile, program);
  if (actual === undefined || actual === null) {
    return { ...base, outcome: 'unknown', reason: 'The user has not stated this information' };
  }

  const matched = applyOperator(rule.operator, actual, rule.value);
  if (matched === null) {
    return { ...base, outcome: 'unknown', reason: 'Rule value could not be interpreted' };
  }

  return {
    ...base,
    outcome: matched ? 'met' : 'unmet',
    reason: matched
      ? `Stated value "${String(actual)}" satisfies the rule`
      : `Stated value "${String(actual)}" does not satisfy the rule`,
  };
}

function resolveField(
  field: RuleField,
  profile: UserProfile,
  program: ProgramRecord,
): string | number | boolean | undefined {
  switch (field) {
    case RuleField.COUNTY:
      return profile.county;
    case RuleField.EMPLOYMENT_STATUS:
      return profile.employmentStatus;
    case RuleField.AGE:
      return ageFromBand(profile.ageBand);
    case RuleField.VETERAN_STATUS:
      return profile.isVeteran;
    case RuleField.DISABILITY_STATUS:
      return profile.hasDisability;
    case RuleField.AUDIENCE:
      return profile.audience;
    case RuleField.INCOME_LEVEL:
      // Never collected. Income questions always route to staff.
      return undefined;
    case RuleField.EDUCATION_LEVEL:
    case RuleField.OTHER:
      return undefined;
    default: {
      // Exhaustiveness guard: a new RuleField must be handled explicitly
      // rather than silently defaulting to "unknown".
      const _never: never = field;
      void _never;
      void program;
      return undefined;
    }
  }
}

/** Midpoint of an age band — enough to test a GTE/LTE/BETWEEN boundary. */
function ageFromBand(band: UserProfile['ageBand']): number | undefined {
  switch (band) {
    case 'under_18':
      return 17;
    case '18_24':
      return 21;
    case '25_54':
      return 40;
    case '55_plus':
      return 60;
    default:
      return undefined;
  }
}

function applyOperator(
  operator: RuleOperator,
  actual: string | number | boolean,
  expected: unknown,
): boolean | null {
  switch (operator) {
    case RuleOperator.IN:
      return Array.isArray(expected) ? expected.map(norm).includes(norm(actual)) : null;
    case RuleOperator.NOT_IN:
      return Array.isArray(expected) ? !expected.map(norm).includes(norm(actual)) : null;
    case RuleOperator.EQUALS:
      return norm(actual) === norm(expected);
    case RuleOperator.GTE:
      return typeof actual === 'number' && typeof expected === 'number' ? actual >= expected : null;
    case RuleOperator.LTE:
      return typeof actual === 'number' && typeof expected === 'number' ? actual <= expected : null;
    case RuleOperator.BETWEEN: {
      if (typeof actual !== 'number' || !Array.isArray(expected) || expected.length !== 2) return null;
      const [min, max] = expected as [unknown, unknown];
      if (typeof min !== 'number' || typeof max !== 'number') return null;
      return actual >= min && actual <= max;
    }
    case RuleOperator.EXISTS:
      return actual !== undefined && actual !== null && actual !== '';
    default: {
      const _never: never = operator;
      void _never;
      return null;
    }
  }
}

function norm(value: unknown): string {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Checks the geographic boundary. A program with no recorded service area is
 * treated as agency-wide rather than as excluded — the agency's own pages
 * describe most services without naming a county.
 */
export function servesCounty(program: ProgramRecord, county?: string): 'yes' | 'no' | 'unknown' {
  if (program.serviceAreas.length === 0) return 'unknown';
  if (!county) return 'unknown';
  return program.serviceAreas.some((area) => area.county === county) ? 'yes' : 'no';
}
