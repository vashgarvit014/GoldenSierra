import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import type { CounselorContext, PopulationTag } from '@/types/counselor';

/**
 * Context extraction for counselor mode.
 *
 * A deterministic rule pass runs first and always; the model refines it when
 * available. That ordering matters — the rules are what keep the conversation
 * coherent when the provider is slow, and they cost nothing.
 *
 * Only workforce-relevant facts are captured. The prompt and the schema both
 * refuse names, addresses, phone numbers and dates of birth.
 */

const CITY_TO_COUNTY: Record<string, 'Placer' | 'El Dorado' | 'Alpine'> = {
  roseville: 'Placer', rocklin: 'Placer', lincoln: 'Placer', auburn: 'Placer',
  colfax: 'Placer', loomis: 'Placer', 'granite bay': 'Placer', 'north tahoe': 'Placer',
  placerville: 'El Dorado', 'south lake tahoe': 'El Dorado', 'cameron park': 'El Dorado',
  'el dorado hills': 'El Dorado', 'shingle springs': 'El Dorado', georgetown: 'El Dorado',
  markleeville: 'Alpine',
};

const POPULATION_PATTERNS: [RegExp, PopulationTag][] = [
  [/\bformer foster|foster (youth|care|kid|child)|aged out of (foster|care)\b/i, 'former_foster_youth'],
  [/\bveteran|ex-military|served in the (army|navy|marines|air force)\b/i, 'veteran'],
  [/\bdisabilit|wheelchair|accommodation|blind|deaf|autis|neurodiver/i, 'disability'],
  [/\blow[- ]income|can'?t afford|no money|struggling financially\b/i, 'low_income'],
  [/\blaid off|layoff|redundan|plant clos|business clos|downsiz/i, 'dislocated_worker'],
  [/\benglish (language )?learner|esl\b|refugee|immigrant|newcomer/i, 'english_learner'],
  [/\bjustice[- ]involved|reentry|re-entry|incarcerat|on parole|probation\b/i, 'justice_involved'],
];

/**
 * Trims a career interest to the noun phrase. Applied to every source,
 * because the model copies the user's full clause just as readily as the
 * regex does — "healthcare but hasn't finished her GED" is not an interest.
 */
export function cleanInterest(value: string): string {
  return value
    .split(/\s+(?:but|who|which|that|and|though|although|however|while|since|because|with|without)\b/i)[0]!
    .replace(/['’]\w+$/, '')
    .replace(/[.,;!?]+$/, '')
    .trim()
    .slice(0, 48);
}

/** Rule-based extraction. Always runs; never throws. */
export function ruleExtract(message: string, ctx: CounselorContext): Partial<CounselorContext> {
  const out: Partial<CounselorContext> = {};
  const text = message.trim();
  const lower = text.toLowerCase();

  // ── Age ──
  const ageMatch =
    /\b(\d{1,2})[- ]?(?:year|yr)s?[- ]?old\b/i.exec(text) ??
    /\b(?:she|he|they|i)(?:'s| is| am)\s+(\d{1,2})\b/i.exec(text) ??
    /\bage[d]?\s+(\d{1,2})\b/i.exec(text);
  if (ageMatch) {
    const age = Number(ageMatch[1]);
    if (age > 0 && age < 100) {
      out.age = age;
      out.ageBand = age < 18 ? 'under_18' : age < 25 ? '18_24' : age < 55 ? '25_54' : '55_plus';
      if (age >= 16 && age <= 24) out.population = ['youth'];
    }
  } else if (/\baged? 18 to 24|18-24\b/i.test(text)) out.ageBand = '18_24';
  else if (/\bunder 18\b/i.test(text)) out.ageBand = 'under_18';
  else if (/\b25 to 54|25-54\b/i.test(text)) out.ageBand = '25_54';
  else if (/\b55 (or older|\+)\b/i.test(text)) out.ageBand = '55_plus';

  // ── Location ──
  if (/\bplacer\b/i.test(text)) out.county = 'Placer';
  else if (/\bel\s*dorado\b/i.test(text)) out.county = 'El Dorado';
  else if (/\balpine\b/i.test(text)) out.county = 'Alpine';
  for (const [city, county] of Object.entries(CITY_TO_COUNTY)) {
    if (lower.includes(city)) {
      out.city = city;
      out.county ??= county;
      break;
    }
  }

  // ── Population ──
  const pops = new Set<PopulationTag>(out.population ?? []);
  for (const [pattern, tag] of POPULATION_PATTERNS) if (pattern.test(text)) pops.add(tag);
  if (pops.size) out.population = [...pops];

  // ── Education ──
  if (/\b(ged|hiset|high school)\b.*\b(complete|finished|done|has|got)\b/i.test(text)) out.education = 'ged_or_hs';
  else if (/\b(working on|still doing|studying for|in progress).{0,20}\b(ged|hiset|diploma)\b/i.test(text)) out.education = 'working_on_ged';
  else if (/\b(hasn'?t|has not|not|never|no|without)\b.{0,30}\b(ged|hiset|high school|diploma)\b/i.test(text)) out.education = 'no_hs_diploma';
  else if (/\bsome college\b/i.test(text)) out.education = 'some_college';
  else if (/\b(degree|bachelor|associate)\b/i.test(text)) out.education = 'degree';

  // ── Transportation ──
  if (/\bno (reliable )?(transport|car|vehicle|way to get)|can'?t drive|doesn'?t drive|without a car\b/i.test(text)) out.transportation = 'none';
  else if (/\b(bus|transit|public transport)( only)?\b/i.test(text)) out.transportation = 'transit_only';
  else if (/\bhas a car|own car|can drive|own vehicle|reliable transport\b/i.test(text)) out.transportation = 'own_vehicle';

  // ── Income urgency ──
  if (/\bneeds? (income|money|a job|work) (now|soon|right away|asap)|income as soon|urgent\b/i.test(text)) out.incomeUrgency = 'immediate';
  else if (/\bcan (focus on |do )?train|train first|few months|no rush\b/i.test(text)) out.incomeUrgency = 'can_train_first';
  else if (/\bopen to (both|either)\b/i.test(text)) out.incomeUrgency = 'flexible';

  // ── Employment ──
  if (/\bunemployed|not working|out of work|no job|jobless\b/i.test(text)) out.employmentStatus = 'unemployed';
  else if (/\blaid off|layoff|let go\b/i.test(text)) out.employmentStatus = 'laid_off';
  else if (/\bworking but|part[- ]time|need more hours|underemployed\b/i.test(text)) out.employmentStatus = 'underemployed';
  else if (/\bstudent|in school\b/i.test(text)) out.employmentStatus = 'student';

  // ── Career interest ──
  const interest =
    /\b(?:interested in|wants? to (?:work|go) in|career in|looking at|aiming for|get into|pathway (?:in|to))\s+([a-z][a-z\s&/-]{2,34})/i.exec(text);
  if (interest?.[1]) {
    // Stop at a clause boundary — "healthcare but hasn't finished her GED"
    // must not become a career interest of "healthcare but hasn".
    out.careerInterest = cleanInterest(interest[1]);
  }
  else if (/\bhealthcare|nursing|medical|cna\b/i.test(text)) out.careerInterest = 'healthcare';
  else if (/\btrades?|construction|welding|electric|plumb|forklift\b/i.test(text)) out.careerInterest = 'the trades';
  else if (/\boffice|admin|clerical|bookkeep\b/i.test(text)) out.careerInterest = 'office work';
  else if (/\bit\b|tech|software|cyber|comput/i.test(text)) out.careerInterest = 'technology';

  // ── Audience ──
  if (/\b(my|our) (business|company|staff|team)\b|\bi(?:'m| am) an employer\b|\bhiring for\b/i.test(text)) out.audience = 'employer';
  else if (/\b(looking for work|need a job|find (me )?a job|helping (a|an|someone|my))\b/i.test(text)) out.audience = 'job_seeker';

  // ── Barriers ──
  const barriers = new Set(ctx.barriers ?? []);
  if (/\bchild ?care|kids to look after|no babysitter\b/i.test(text)) barriers.add('childcare');
  if (out.transportation === 'none') barriers.add('transportation');
  if (/\bhous(ing|ed)|homeless|couch ?surf|shelter\b/i.test(text)) barriers.add('housing');
  if (barriers.size) out.barriers = [...barriers];

  return out;
}

// ── LLM refinement ───────────────────────────────────────────────────────

const ExtractSchema = z.object({
  age: z.coerce.number().int().min(10).max(99).nullish(),
  county: z.string().nullish(),
  city: z.string().max(60).nullish(),
  population: z.array(z.string()).max(6).optional().default([]),
  careerInterest: z.string().max(60).nullish(),
  education: z.string().nullish(),
  employmentStatus: z.string().nullish(),
  transportation: z.string().nullish(),
  incomeUrgency: z.string().nullish(),
  barriers: z.array(z.string().max(40)).max(6).optional().default([]),
  audience: z.string().nullish(),
  /** Set when the user is correcting something said earlier. */
  corrections: z.array(z.string().max(40)).max(6).optional().default([]),
});

const EXTRACT_SYSTEM = `You extract workforce facts from a message sent to a Golden Sierra workforce counselor (Placer, El Dorado and Alpine counties, California).

Return JSON only. Never answer the question, never give advice.

Record ONLY what the message actually states or plainly implies. Omit anything not said — do not guess.

NEVER extract: names, street addresses, phone numbers, email addresses, dates of birth, immigration status, medical diagnoses, or any identifier. Age as a number is fine.

Field values:
  county: Placer | El Dorado | Alpine
  population: former_foster_youth, veteran, youth, disability, low_income, dislocated_worker, english_learner, justice_involved
  education: no_hs_diploma | working_on_ged | ged_or_hs | some_college | degree
  employmentStatus: unemployed | employed | underemployed | laid_off | student
  transportation: own_vehicle | transit_only | none
  incomeUrgency: immediate | can_train_first | flexible
  audience: job_seeker | employer

corrections: list any field the user is CHANGING from what they said before (e.g. they said Placer earlier and now say El Dorado).

In helper mode the user describes someone else — extract facts about that person, not the helper.`;

export async function extractContext(
  message: string,
  ctx: CounselorContext,
  history: { role: string; content: string }[],
): Promise<{ updates: Partial<CounselorContext>; corrections: string[] }> {
  const baseline = ruleExtract(message, ctx);
  if (!hasLlm()) return { updates: baseline, corrections: [] };

  try {
    const client = getLlmClient();
    const response = await withTimeout(
      client.chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0,
        max_tokens: structuredTokenBudget(400),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          ...history.slice(-4).map((h) => ({
            role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: h.content.slice(0, 900),
          })),
          {
            role: 'user',
            content:
              `Mode: ${ctx.mode}\nAlready known: ${JSON.stringify(stripEmpty(ctx))}\n\nLatest message:\n${message.slice(0, 1500)}`,
          },
        ],
      }),
      15_000,
      'context extraction',
    );

    const data = parseModelJson(
      response.choices[0]?.message?.content,
      (value) => {
        const r = ExtractSchema.safeParse(value);
        return r.success
          ? ({ success: true, data: r.data } as const)
          : ({ success: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } as const);
      },
      'Context extraction',
    );
    if (!data) return { updates: baseline, corrections: [] };

    // Model output layers over the rule baseline, never replaces it wholesale.
    const merged: Partial<CounselorContext> = { ...baseline };
    if (data.age != null) {
      merged.age = data.age;
      merged.ageBand = data.age < 18 ? 'under_18' : data.age < 25 ? '18_24' : data.age < 55 ? '25_54' : '55_plus';
    }
    const county = normaliseCounty(data.county);
    if (county) merged.county = county;
    if (data.city) merged.city = data.city.toLowerCase();
    if (data.careerInterest) {
      const cleaned = cleanInterest(data.careerInterest);
      if (cleaned.length >= 3) merged.careerInterest = cleaned;
    }
    if (isOneOf(data.education, ['no_hs_diploma', 'working_on_ged', 'ged_or_hs', 'some_college', 'degree'])) {
      merged.education = data.education as CounselorContext['education'];
    }
    if (isOneOf(data.employmentStatus, ['unemployed', 'employed', 'underemployed', 'laid_off', 'student'])) {
      merged.employmentStatus = data.employmentStatus as CounselorContext['employmentStatus'];
    }
    if (isOneOf(data.transportation, ['own_vehicle', 'transit_only', 'none'])) {
      merged.transportation = data.transportation as CounselorContext['transportation'];
    }
    if (isOneOf(data.incomeUrgency, ['immediate', 'can_train_first', 'flexible'])) {
      merged.incomeUrgency = data.incomeUrgency as CounselorContext['incomeUrgency'];
    }
    if (isOneOf(data.audience, ['job_seeker', 'employer'])) {
      merged.audience = data.audience as CounselorContext['audience'];
    }

    const valid: PopulationTag[] = [
      'former_foster_youth', 'veteran', 'youth', 'disability',
      'low_income', 'dislocated_worker', 'english_learner', 'justice_involved',
    ];
    const pops = new Set<PopulationTag>([...(baseline.population ?? [])]);
    for (const p of data.population) if (valid.includes(p as PopulationTag)) pops.add(p as PopulationTag);
    if (pops.size) merged.population = [...pops];

    if (data.barriers.length) {
      merged.barriers = [...new Set([...(baseline.barriers ?? []), ...data.barriers])];
    }

    return { updates: merged, corrections: data.corrections ?? [] };
  } catch (err) {
    logger.warn('Counselor extraction unavailable; using rules only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { updates: baseline, corrections: [] };
  }
}

/** Later statements win, so a user can correct themselves naturally. */
export function mergeContext(
  current: CounselorContext,
  updates: Partial<CounselorContext>,
): CounselorContext {
  const next: CounselorContext = { ...current };
  for (const [key, value] of Object.entries(updates) as [keyof CounselorContext, unknown][]) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const previous = (current[key] as string[] | undefined) ?? [];
      (next[key] as string[]) = [...new Set([...previous, ...(value as string[])])].slice(0, 8);
    } else {
      (next[key] as unknown) = value;
    }
  }
  return next;
}

function normaliseCounty(value: string | null | undefined) {
  if (!value) return undefined;
  const v = value.toLowerCase().replace(/\s+county\b/g, '').trim();
  if (v === 'placer') return 'Placer' as const;
  if (/^el\s*dorado$/.test(v)) return 'El Dorado' as const;
  if (v === 'alpine') return 'Alpine' as const;
  return undefined;
}

function isOneOf(value: string | null | undefined, allowed: string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function stripEmpty(ctx: CounselorContext) {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
}
