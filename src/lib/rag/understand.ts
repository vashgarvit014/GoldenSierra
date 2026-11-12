import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { INTENTS, type Intent, type QueryAnalysis, type UserProfile } from '@/types/chat';

/**
 * Query understanding.
 *
 * Runs before retrieval and does four things:
 *   - classifies intent,
 *   - rewrites the message into a standalone query (resolving "it", "that one",
 *     "what about for me"), which is what makes follow-up questions retrievable,
 *   - pulls out workforce facts the user volunteered,
 *   - decides whether one clarifying question is genuinely needed.
 *
 * A deterministic rule pass runs first and always. The LLM refines it when
 * available; if the model is down or returns nonsense, the rule result stands,
 * so the assistant degrades rather than failing.
 */

const COUNTY_PATTERNS: [RegExp, 'Placer' | 'El Dorado' | 'Alpine'][] = [
  [/\bplacer\b/i, 'Placer'],
  [/\bel\s*dorado\b/i, 'El Dorado'],
  [/\balpine\b/i, 'Alpine'],
];

/** Cities we can confidently map to a served county. */
const CITY_TO_COUNTY: Record<string, 'Placer' | 'El Dorado' | 'Alpine'> = {
  roseville: 'Placer',
  rocklin: 'Placer',
  lincoln: 'Placer',
  auburn: 'Placer',
  'colfax': 'Placer',
  loomis: 'Placer',
  'granite bay': 'Placer',
  tahoe: 'Placer',
  'placer county': 'Placer',
  'placerville': 'El Dorado',
  'south lake tahoe': 'El Dorado',
  'cameron park': 'El Dorado',
  'el dorado hills': 'El Dorado',
  'shingle springs': 'El Dorado',
  diamond: 'El Dorado',
  georgetown: 'El Dorado',
  markleeville: 'Alpine',
};

const INTENT_RULES: { intent: Intent; pattern: RegExp; weight: number }[] = [
  { intent: 'employer_hiring', pattern: /\b(my business|my company|our company|we are hiring|we're hiring|i am an employer|i'm an employer|post a job|job posting for|find (workers|employees|candidates)|recruit)\b/i, weight: 4 },
  { intent: 'employer_training', pattern: /\b(train my (staff|team|employees|workers)|training my (staff|team|employees)|employee training|staff training|on-the-job training|\bojt\b|wage reimbursement|hiring incentive)\b/i, weight: 4 },
  { intent: 'internship', pattern: /\binternships?\b|\binterns?\b|\bwork experience\b|\bpaid experience\b/i, weight: 3 },
  { intent: 'financial_assistance', pattern: /\bscholarships?\b|\btuition\b|\bfinancial (aid|assistance|help)\b|\bpay for (school|training|classes|a course)\b|\bafford\b|\bgrants?\b|\bmoney for\b|\bcover the cost\b/i, weight: 4 },
  { intent: 'find_training', pattern: /\btrainings?\b|\blearn a (new )?skill\b|\bcertifications?\b|\bcredentials?\b|\bcourses?\b|\bclasses\b|\bschool\b|\bupskill\b|\bretrain\b|\bapprentice(ship)?s?\b/i, weight: 2 },
  { intent: 'eligibility', pattern: /\beligib\w*\b|\bqualif\w*\b|\bdo i (have to|need to)\b|\brequirements?\b|\bam i able\b|\bwho can apply\b|\bincome limit\b/i, weight: 3 },
  { intent: 'career_counseling', pattern: /\bcareer (advice|counsel\w*|coach\w*|guidance|plan\w*)\b|\bnot sure what\b|\bwhat career\b|\bchange careers\b|\bresume help\b|\badvisors?\b/i, weight: 2 },
  { intent: 'contact_referral', pattern: /\bcontact\b|\bphone number\b|\bcall you\b|\bemail\b|\baddress\b|\bwhere are you\b|\boffice hours\b|\bspeak to (someone|a person)\b|\bappointments?\b|\bget in touch\b/i, weight: 3 },
  { intent: 'local_services', pattern: /\bnear me\b|\bin my area\b|\blocal\b|\bmy county\b|\bplacer\b|\bel dorado\b|\balpine\b|\blocations?\b/i, weight: 1 },
  { intent: 'find_job', pattern: /\bfind (a )?job\b|\blooking for work\b|\bjob search\b|\bhiring\b|\bjob openings?\b|\bemployment\b|\bget hired\b|\bunemployed\b|\bjobs?\b/i, weight: 2 },
  { intent: 'general_info', pattern: /\bwhat (is|does) golden sierra\b|\bwho are you\b|\bwhat services\b|\btell me about\b|\bhow (does|can) (you|this) (help|work)\b/i, weight: 2 },
];

/** Topics that are plainly outside workforce services. */
const OFF_TOPIC = /\b(weather|recipe|sports score|stock price|movie|joke|poem|who won|capital of|translate this|write code)\b/i;

export function ruleBasedAnalysis(message: string, history: { role: string; content: string }[]): QueryAnalysis {
  const text = message.trim();
  const profileUpdates: UserProfile = {};

  // ── Location ──
  for (const [pattern, county] of COUNTY_PATTERNS) {
    if (pattern.test(text)) {
      profileUpdates.county = county;
      break;
    }
  }
  if (!profileUpdates.county) {
    const lower = text.toLowerCase();
    for (const [city, county] of Object.entries(CITY_TO_COUNTY)) {
      if (lower.includes(city)) {
        profileUpdates.county = county;
        profileUpdates.locationText = city;
        break;
      }
    }
  }

  // ── Employment status ──
  if (/\b(unemployed|out of work|lost my job|no job|jobless)\b/i.test(text)) {
    profileUpdates.employmentStatus = 'unemployed';
  } else if (/\b(laid off|layoff|let go|downsiz|my company clos)\b/i.test(text)) {
    profileUpdates.employmentStatus = 'laid_off';
  } else if (/\b(part[- ]time|need more hours|underemployed|not enough hours)\b/i.test(text)) {
    profileUpdates.employmentStatus = 'underemployed';
  } else if (/\b(i (work|am working|have a job)|currently employed|my job)\b/i.test(text)) {
    profileUpdates.employmentStatus = 'employed';
  } else if (/\b(student|in school|graduating|just graduated)\b/i.test(text)) {
    profileUpdates.employmentStatus = 'student';
  }

  // ── Audience ──
  if (
    /\b(my|our) (business|company|staff|team|employees|workers|organization)\b|\bwe (hire|are hiring|employ)\b|\bi(?:'m| am) an employer\b|\bas an employer\b/i.test(
      text,
    )
  ) {
    profileUpdates.audience = 'employer';
  } else if (/\b(i am|i'm|i need|help me|for me|my resume|my career)\b/i.test(text)) {
    profileUpdates.audience = 'job_seeker';
  }

  // ── Priority populations ──
  if (/\b(veteran|served in the (army|navy|air force|marines)|military)\b/i.test(text)) {
    profileUpdates.isVeteran = true;
  }
  if (/\b(disabilit|wheelchair|accommodation|blind|deaf)\b/i.test(text)) {
    profileUpdates.hasDisability = true;
  }
  const ageMatch = /\bi(?:'m| am)\s+(\d{1,2})\b|\b(\d{1,2})\s*years?\s*old\b/i.exec(text);
  if (ageMatch) {
    const age = Number(ageMatch[1] ?? ageMatch[2]);
    if (age > 0 && age < 100) {
      profileUpdates.ageBand = age < 18 ? 'under_18' : age < 25 ? '18_24' : age < 55 ? '25_54' : '55_plus';
    }
  }

  // ── Interests ──
  const interestMatch = text.match(
    /\b(?:interested in|want to (?:work|be|become|learn)|career in|get into|job in)\s+([a-z][a-z\s&/-]{2,40})/i,
  );
  if (interestMatch?.[1]) {
    profileUpdates.careerInterests = [interestMatch[1].trim().replace(/[.,;!?]+$/, '')];
  }

  // ── Intent ──
  const scores = new Map<Intent, number>();
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) scores.set(rule.intent, (scores.get(rule.intent) ?? 0) + rule.weight);
  }
  // An employer framing biases every downstream intent.
  if (profileUpdates.audience === 'employer') {
    scores.set('employer_hiring', (scores.get('employer_hiring') ?? 0) + 2);
  }

  let intent: Intent = 'general_info';
  let best = 0;
  for (const [candidate, score] of scores) {
    if (score > best) {
      intent = candidate;
      best = score;
    }
  }
  if (best === 0 && OFF_TOPIC.test(text)) intent = 'off_topic';

  const keywords = extractKeywords(text);
  const subQuestions = splitQuestions(text);

  return {
    intent,
    confidence: best === 0 ? 0.3 : Math.min(0.9, 0.45 + best * 0.1),
    rewrittenQuery: resolveReferences(text, history),
    keywords,
    profileUpdates,
    missingInfo: null,
    isMultiPart: subQuestions.length > 1,
    subQuestions,
  };
}

/** Proper nouns and program terms worth an exact keyword match. */
export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  const KNOWN = [
    'WIOA', 'OJT', 'on-the-job training', 'Metrix', 'scholarship', 'internship',
    'apprenticeship', 'Placer', 'El Dorado', 'Alpine', 'CalJOBS', 'rapid response',
    'layoff', 'resume', 'veteran', 'workshop', 'hiring event', 'career clinic',
    'tuition', 'wage reimbursement', 'orientation',
  ];
  for (const term of KNOWN) {
    if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      keywords.add(term);
    }
  }
  // Capitalised multi-word phrases are usually program or place names.
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3})\b/g)) {
    const phrase = match[1]!;
    if (phrase.length > 5 && !/^(What|When|Where|Which|Does|Can|How|The|This|That|Golden Sierra)/.test(phrase)) {
      keywords.add(phrase);
    }
  }
  return [...keywords].slice(0, 8);
}

/**
 * Cheap pronoun resolution so a follow-up like "am I eligible for that?"
 * retrieves against the program named two turns ago rather than nothing.
 */
function resolveReferences(text: string, history: { role: string; content: string }[]): string {
  const hasReference = /\b(it|that|those|this|them|the (program|one|service)|there)\b/i.test(text);
  const isShort = text.split(/\s+/).length < 8;
  if (!hasReference && !isShort) return text;

  const recentAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!recentAssistant) return text;

  // Pull the headings/program names the last answer offered.
  const mentioned = [...recentAssistant.content.matchAll(/\*\*(?:\d+\.\s*)?([A-Z][^*\n]{3,60})\*\*/g)]
    .map((m) => m[1]!.trim())
    .slice(0, 3);

  return mentioned.length ? `${text} (referring to: ${mentioned.join(', ')})` : text;
}

function splitQuestions(text: string): string[] {
  const parts = text
    .split(/(?<=\?)\s+|\s+(?:and also|also,|additionally|plus,)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 8);
  return parts.length > 1 ? parts.slice(0, 4) : [text];
}

// ─────────────────────────── LLM refinement ───────────────────────────

const AnalysisSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  rewritten_query: z.string().min(1).max(500),
  keywords: z.array(z.string()).max(10).default([]),
  profile: z
    .object({
      county: z.enum(['Placer', 'El Dorado', 'Alpine']).nullish(),
      employment_status: z
        .enum(['unemployed', 'employed', 'underemployed', 'laid_off', 'student', 'unknown'])
        .nullish(),
      audience: z.enum(['job_seeker', 'employer']).nullish(),
      career_interests: z.array(z.string()).max(5).nullish(),
      existing_skills: z.array(z.string()).max(5).nullish(),
      training_needs: z.array(z.string()).max(5).nullish(),
      is_veteran: z.boolean().nullish(),
    })
    .default({}),
  missing_info: z.string().max(200).nullish(),
  sub_questions: z.array(z.string()).max(4).default([]),
});

const ANALYSIS_SYSTEM = `You analyse messages sent to a workforce-services assistant for Golden Sierra Job Training Agency (Placer, El Dorado and Alpine counties, California).

Return JSON only. Your job is classification and extraction — never answer the question.

intent: one of find_job, find_training, financial_assistance, career_counseling, internship, eligibility, employer_hiring, employer_training, local_services, contact_referral, general_info, off_topic.

rewritten_query: rewrite the latest message as a standalone search query, resolving pronouns using the conversation so far. Keep it under 30 words. If the message is already standalone, return it essentially unchanged.

keywords: exact terms worth a literal match — program names, county names, credentials. Omit generic words.

profile: ONLY facts the user actually stated. Never infer, never guess. Omit anything not said. Never extract names, addresses, phone numbers, email addresses, or dates of birth even when offered.

missing_info: the single most useful question to ask ONLY IF the answer cannot be usefully attempted without it. Most messages need nothing — return null. Never ask for a county when the question applies agency-wide. Never ask more than one thing.

sub_questions: if the message asks several distinct things, list them; otherwise return an empty array.`;

export async function analyzeQuery(
  message: string,
  history: { role: string; content: string }[],
  knownProfile: UserProfile,
): Promise<QueryAnalysis> {
  const baseline = ruleBasedAnalysis(message, history);
  if (!hasLlm()) return baseline;

  try {
    const client = getLlmClient();
    const recent = history.slice(-6).map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content.slice(0, 1200),
    }));

    const response = await withTimeout(
      client.chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM },
          ...recent,
          {
            role: 'user',
            content:
              `Already known about this user (do not re-ask these): ${JSON.stringify(knownProfile)}\n\n` +
              `Latest message:\n${message.slice(0, 2000)}`,
          },
        ],
      }),
      15_000,
      'query analysis',
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return baseline;

    const parsed = AnalysisSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn('Query analysis failed schema validation; using rule-based result', {
        issues: parsed.error.issues.slice(0, 3),
      });
      return baseline;
    }

    const data = parsed.data;
    const profileUpdates: UserProfile = { ...baseline.profileUpdates };
    if (data.profile.county) profileUpdates.county = data.profile.county;
    if (data.profile.employment_status && data.profile.employment_status !== 'unknown') {
      profileUpdates.employmentStatus = data.profile.employment_status;
    }
    if (data.profile.audience) profileUpdates.audience = data.profile.audience;
    if (data.profile.career_interests?.length) profileUpdates.careerInterests = data.profile.career_interests;
    if (data.profile.existing_skills?.length) profileUpdates.existingSkills = data.profile.existing_skills;
    if (data.profile.training_needs?.length) profileUpdates.trainingNeeds = data.profile.training_needs;
    if (data.profile.is_veteran != null) profileUpdates.isVeteran = data.profile.is_veteran;

    // Never ask for something the session already knows.
    const missing = data.missing_info?.trim() || null;
    const redundant =
      missing != null &&
      ((knownProfile.county && /count(y|ies)|where.*live|location/i.test(missing)) ||
        (knownProfile.audience && /employer or|job seeker or|business owner/i.test(missing)));

    return {
      intent: data.intent,
      confidence: data.confidence,
      rewrittenQuery: data.rewritten_query || baseline.rewrittenQuery,
      keywords: [...new Set([...data.keywords, ...baseline.keywords])].slice(0, 10),
      profileUpdates,
      missingInfo: redundant ? null : missing,
      isMultiPart: data.sub_questions.length > 1,
      subQuestions: data.sub_questions.length > 1 ? data.sub_questions : baseline.subQuestions,
    };
  } catch (err) {
    logger.warn('Query analysis unavailable; using rule-based result', {
      error: err instanceof Error ? err.message : String(err),
    });
    return baseline;
  }
}

/** Merges newly-learned facts over what the session already knows. */
export function mergeProfile(existing: UserProfile, updates: UserProfile): UserProfile {
  const merged: UserProfile = { ...existing };
  for (const [key, value] of Object.entries(updates) as [keyof UserProfile, unknown][]) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const previous = (existing[key] as string[] | undefined) ?? [];
      (merged[key] as string[]) = [...new Set([...previous, ...(value as string[])])].slice(0, 8);
    } else {
      (merged[key] as unknown) = value;
    }
  }
  return merged;
}
