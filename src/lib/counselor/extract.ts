import { pronounIn } from '../conversation/voice';
import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import type { CounselorContext, PopulationTag } from '@/types/counselor';
import { OCCUPATION_BY_KEY, classify, skillsIn } from '../jobs/occupations';
import { extractQuals } from '../jobs/qualifications';

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
export type ContextUpdate = Partial<CounselorContext> & {
  /** Population tags the message explicitly negates ("he's not a veteran"); removed on merge. */
  withdrawn?: PopulationTag[];
};

export function ruleExtract(message: string, ctx: CounselorContext): ContextUpdate {
  const out: ContextUpdate = {};
  const text = message.trim();
  const lower = text.toLowerCase();

  // ── Who the conversation is about ── (asking on someone else's behalf → "they", never "you")
  const helping = () => (out.mode ?? ctx.mode) === 'helper';
  if (/\b(i'?m|i am|we'?re|we are)\s+(helping|assisting|supporting|working with|asking (for|on behalf of))\b|\bon behalf of\b|\bmy (client|son|daughter|nephew|niece|brother|sister|friend|student|mentee)\b/i.test(text)) out.mode = 'helper';
  if (helping() && !ctx.pronoun) {
    const p = pronounIn(text);
    if (p) out.pronoun = p;
  }

  // ── Age ──
  const ageMatch =
    /\b(\d{1,2})[- ]?(?:year|yr)s?[- ]?old\b/i.exec(text) ??
    /\b(\d{1,2})\s*(?:y\/?o|yrs?)\b/i.exec(text) ??
    /\bturned (\d{1,2})\b/i.exec(text) ??
    /\b(?:she|he|they|i)(?:'s| is| am| are)\s+(?:only |now |just |about )?(\d{1,2})\b(?!\s*(?:hours|days|weeks|months|miles|minutes|%))/i.exec(text) ??
    /\b(?:son|daughter|client|nephew|niece|brother|sister|friend|student|grandson|granddaughter),?\s+(?:who is |aged? )?(\d{1,2})\b(?!\s*(?:hours|days|weeks|months|miles))/i.exec(text) ??
    /\bage[d]?\s+(\d{1,2})\b(?!\s*(?:to|-|or))/i.exec(text);
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

  // ── Location ── ("I meant El Dorado, not Placer": a place that is negated is not where they are)
  const placeText = lower.replace(/\b(?:not|instead of|rather than|no longer in|moved (?:away )?from|used to live in)\s+(?:in\s+)?([a-z]+(?:\s+[a-z]+)?)/g, ' ');
  if (/\bplacer\b/.test(placeText)) out.county = 'Placer';
  else if (/\bel\s*dorado\b/.test(placeText)) out.county = 'El Dorado';
  else if (/\balpine\b/.test(placeText)) out.county = 'Alpine';
  // Longest names first, so "el dorado hills" is not read as the county alone.
  for (const [city, county] of Object.entries(CITY_TO_COUNTY).sort((x, y) => y[0].length - x[0].length)) {
    if (placeText.includes(city)) {
      out.city = city;
      // A named town decides the county unless a county is stated separately.
      if (!out.county || !/\bcounty\b/.test(placeText)) out.county = county;
      break;
    }
  }

  // ── Population ── (a negated mention — "he's not a veteran" — withdraws the tag instead)
  const pops = new Set<PopulationTag>(out.population ?? []);
  const withdrawn: PopulationTag[] = [];
  for (const [pattern, tag] of POPULATION_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/\b(?:not|isn'?t|wasn'?t|never (?:was|been)|no longer)\s+(?:a |an |in |from )?$/i.test(before)) withdrawn.push(tag);
    else pops.add(tag);
  }
  if (pops.size) out.population = [...pops];
  if (withdrawn.length) out.withdrawn = withdrawn;

  // ── Education ── (in progress, then negation, then completion: "hasn't completed her GED" is not done)
  if (/\b(working on|studying for|taking|enrolled in|attending|signed up for|in)\s+(?:a |an |her |his |their |my |the )?(ged|hiset)\b|\b(ged|hiset)\s+(classes|prep|program|course)/i.test(text) && !/\b(not|never|isn'?t|hasn'?t)\b.{0,20}\b(ged|hiset)\s+(classes|prep|program|course)/i.test(text)) out.education = 'working_on_ged';
  else if (/\b(hasn'?t|has not|have not|haven'?t|didn'?t|did not|not|never|no|without)\b.{0,30}\b(ged|hiset|high school|diploma)\b|\bdropped out\b|\b(ged|diploma)\s+(is\s+)?(incomplete|unfinished|not (done|finished|complete))/i.test(text)) out.education = 'no_hs_diploma';
  else if (/\b(ged|hiset|high school)\b.{0,30}\b(completed?|finished|done|passed)\b|\b(completed?|finished|passed|got|has|have|earned)\s+(her|his|their|my|the|a)?\s*(ged|hiset|high school diploma|high school|diploma)\b|\bgraduated( from)? high school\b|\bhigh school (grad|graduate)\b/i.test(text)) out.education = 'ged_or_hs';
  else if (/\bsome college\b|\bcommunity college\b|\bcollege (classes|courses|credits)\b/i.test(text)) out.education = 'some_college';
  else if (/\b(degree|bachelor|associate|graduated (from )?college)\b/i.test(text)) out.education = 'degree';

  // ── Transportation ── (negation first: "doesn't have a car" must not read as "has a car")
  const NEG_HAVE = String.raw`(?:no|without(?: a)?|doesn'?t have(?: a)?|does not have(?: a)?|don'?t have(?: a)?|do not have(?: a)?|hasn'?t got(?: a)?|lost (?:her|his|their|my))`;
  if (new RegExp(String.raw`\b${NEG_HAVE}\s+(?:reliable |own |a )?(?:transport\w*|car|vehicle|ride|license|licence|way to get)|can'?t drive|cannot drive|doesn'?t drive|does not drive|don'?t drive`, 'i').test(text)) out.transportation = 'none';
  else if (/\b(takes?|taking|rides?|uses?|relies on|relying on|by)\s+(?:the )?(bus|transit|light rail|public transport\w*)|\b(bus|transit|public transport\w*)\s+only\b|\bpublic transit\b|\bonly (?:the )?bus\b/i.test(text)) out.transportation = 'transit_only';
  else if (/\b(has|have|got)\s+(?:a |her |his |their |my )?(?:own )?(?:car|vehicle)\b|\bown car|\bcan drive|\bdrives\b|\bown vehicle|\breliable transport/i.test(text)) out.transportation = 'own_vehicle';

  // ── Income urgency ──
  if (/\bneeds? (?:income|money|a job|work|to earn|a paycheck) (?:now|soon|right away|asap|quickly|fast|immediately)|income as soon|\burgent(?:ly)?\b|as soon as possible|right away|immediately|\basap\b|\bpaycheck (?:asap|now|soon|fast)|\bmoney fast\b|\bbills (?:are )?(?:due|piling)|\bcan'?t afford to wait|\bbehind on rent\b/i.test(text)) out.incomeUrgency = 'immediate';
  else if (/\bcan (?:focus on |do |afford to )?train|\btrain(?:ing)? first|few months|\bno rush\b|\bnot in a (?:hurry|rush)\b|\bhas savings\b|\bcan wait\b/i.test(text)) out.incomeUrgency = 'can_train_first';
  else if (/\bopen to (?:both|either)\b(?! (?:technical|kinds? of role))/i.test(text)) out.incomeUrgency = 'flexible';

  // ── Employment ── (a layoff is its own status; it decides dislocated-worker services)
  if (/\blaid off|\blayoff|\blet go\b/i.test(text)) out.employmentStatus = 'laid_off';
  else if (/\bunemployed|\bnot (?:currently |presently |even )?working|\bout of work|\bno job\b|\bjobless|\bbetween jobs|\blost (?:her|his|their|my) job|\bgot fired\b|\b(?:isn'?t|aren'?t|is not) working\b/i.test(text)) out.employmentStatus = 'unemployed';
  else if (/\bworking but|\bpart[- ]time|\bneed more hours|\bunderemployed\b/i.test(text)) out.employmentStatus = 'underemployed';
  else if (/\b(?:found|got|started) a (?:new |full[- ]time )?job\b|\bworks full[- ]time|\bis (?:currently )?employed\b/i.test(text)) out.employmentStatus = 'employed';
  else if (/\bstudent|in school\b/i.test(text)) out.employmentStatus = 'student';

  // ── Career interest ──
  const interest =
    /\b(?:interested in|wants? to (?:work|go) in|career in|looking at|aiming for|get into|pathway (?:in|to))\s+([a-z][a-z\s&/-]{2,34})/i.exec(text);
  const occupation = /\b(?:become|be|work as|training to be)\s+an?\s+([a-z][a-z\s-]{2,30})/i.exec(text);
  // "I worked as a bookkeeper for 6 years" describes past work, not the kind of work they want next.
  const pastOnly = /\b(worked|used to|years (?:as|in|of)|was an?|previously|former)\b/i.test(text) && !/\b(want|wants|interested|looking for|like to|'d like|hoping|aiming|get into|something in|maybe|prefer)\b/i.test(text);
  if (pastOnly) {
    // nothing: the roles named are experience (below)
  } else   if (/\bstill deciding\b|\bundecided\b|\b(?:not sure|no idea|doesn'?t know|don'?t know|unsure)\s+what (?:kind of )?(?:work|job|career)/i.test(text)) out.careerInterest = 'still deciding';
  else if (interest?.[1]) {
    // Stop at a clause boundary — "healthcare but hasn't finished her GED"
    // must not become a career interest of "healthcare but hasn".
    out.careerInterest = cleanInterest(interest[1]);
  } else if (/\bhealthcare|nursing|\bnurse|medical|\bcna\b|caregiv|phlebotom|pharmacy tech|dental assist/i.test(text)) out.careerInterest = 'healthcare';
  else if (/\btrades?\b|construction|welding|welder|electrician|electric|plumb|carpent|hvac|mechanic|forklift/i.test(text)) out.careerInterest = 'the trades';
  else if (/\bfinanc|accountant|accounting|controller|treasurer\b/i.test(text)) out.careerInterest = 'finance and accounting';
  else if (/\boffice|admin|clerical|bookkeep|receptionist/i.test(text)) out.careerInterest = 'office work';
  else if (/\bit\b|tech|software|cyber|comput/i.test(text)) out.careerInterest = 'technology';
  else if (occupation?.[1]) out.careerInterest = cleanInterest(occupation[1]);
  else {
    // "looking for warehouse work", "need a retail job": the kind of work named before "work"/"job".
    const kind = /\b(?:looking for|need|needs|want|wants|find|searching for)\s+(?:a |an |some )?([a-z-]+(?:\s[a-z-]+)?)\s+(?:work|job|jobs|position)\b/i.exec(text)?.[1];
    if (kind && !/^(new|better|different|another|any|full-time|part-time|good|steady|paying|real|some|more|a|the)(\s|$)/i.test(kind)) out.careerInterest = cleanInterest(kind);
  }

  if (/\b(?:need|needs|looking for|find|get|want|wants|searching for)\s+(?:a |an |some )?(?:[\w-]+\s+){0,2}(?:job|work)\b/i.test(text) && !/\btrain(?:ing)?\b/i.test(text)) out.jobGoalStated = true;

  if (/\bno (?:work|job|employment) (?:history|experience)\b|\bnever (?:had a job|worked)\b|\b(?:my|her|his|their) first job\b|\bhaven'?t worked\b/i.test(text)) out.workHistory = 'none';
  else if (/\b(?:i|she|he|they) (?:have |has )?worked (?:in|at|as)\b|\bi'?ve worked\b|\bused to work\b|\b(?:retired|former|previously)\b|\byears? (?:as|in|of)\b/i.test(text) && !ctx.workHistory) out.workHistory = 'described';

  // ── Roles: what they have done vs what they want (occupation taxonomy; vocabulary, not facts) ──
  const roleHits = classify(text, 2).map((h) => h.key).slice(0, 2);
  if (roleHits.length) {
    // "I want to work as an electrician" is a goal, not experience: test the past-work cues without it.
    const GOAL = /\b(?:(?:want|wants|would like|'d like|hoping|hope|hopes|plan(?:ning)?|planning|aim(?:ing)?|trying|like)\s+to\s+(?:work|start working|be|become|get a job)|(?:'d like|would like|want|wants|looking for|interested in|thinking about|considering)\s+(?:an?|some)?\s*[\w-]*\s*(?:job|role|position|work)|maybe|something (?:in|like))\b[^.?!]*/gi;
    const pastText = text.replace(GOAL, '');
    const goalHits = classify((text.match(GOAL) ?? []).join('. '), 2).map((h) => h.key).slice(0, 2);
    const pastHits = classify(pastText, 2).map((h) => h.key).slice(0, 2);
    const did = /\b(worked|work(?:ing)? as|experience|background|used to|years (?:as|in|of)|(?:spent|for|over) (?:\d+|a few|several|one|two|three|four|five|six|seven|eight|nine|ten|many) years|helped|took care of|cared for|supervised|led|operated|installed|repaired|taught|cooked|cleaned|drove|built|fixed|sold|i did|did (?:the )?\w+ing|handled|ran|managed|i was an?|she was an?|he was an?|previously|have been an?|i'?ve been an?|currently an?)\b/i.test(pastText);
    const wants = /\b(want|wants|interested|looking for|become|aiming|hoping|would like|'d like|like to|get into|maybe|something in|something like|thinking about|considering|prefer)\b/i.test(text);
    // A role named in a goal is a target; one named alongside past-work cues is experience. "I want to be
    // an electrician. I have 1 year of experience" is both: the experience is in the role they named.
    if (goalHits.length) out.occupations = goalHits;
    if (did) out.experience = pastHits.length ? pastHits : goalHits.length ? goalHits : roleHits;
    if (did && !ctx.workHistory) out.workHistory = 'described';
    // "Experience installing solar panels, wants a better job" names a past role, not a new target.
    if (wants && !did && !goalHits.length) out.occupations = roleHits;
  }
  // ── Qualifications: degrees, certifications/licenses, years of experience (only when stated) ──
  const pastSectors = [...new Set((out.experience ?? []).map((k) => OCCUPATION_BY_KEY.get(k)!.sector))];
  const q = extractQuals(text, pastSectors);
  if (Object.keys(q.quals).length) out.quals = q.quals;
  if (q.currentTraining) out.currentTraining = q.currentTraining;
  // Keep the coarse education field consistent with an explicit degree statement.
  if (q.quals['edu:bachelor']?.status === 'has' || q.quals['edu:associate']?.status === 'has') out.education = 'degree';
  else if (q.quals['edu:hs']?.status === 'has' && !out.education) out.education = 'ged_or_hs';
  // "No college degree" says nothing about high school: don't let the word "degree" set a level.
  if (q.quals['edu:associate']?.status === 'absent' && out.education === 'degree') delete out.education;
  const skills = skillsIn(text);
  if (skills.length) out.skills = skills;
  if (/\bsupervis|\blead (?:a |the )?(?:team|crew)|\bmanag(?:e|ing) (?:a team|people|staff)|\bsupervisory\b|\bcrew lead\b/i.test(text) && !/\b(not|no|don'?t want)\b.{0,20}supervis/i.test(text)) out.rolePreference = /\bboth\b/i.test(text) ? 'both' : 'supervisory';
  else if (/\bhands-on\b|\btechnical (?:work|role)/i.test(text)) out.rolePreference = /\bboth\b/i.test(text) ? 'both' : 'technical';

  // ── Audience ──
  if (/\b(my|our) (business|company|staff|team|restaurant|shop|store|clinic|firm)\b|\bi(?:'m| am) an employer\b|\bhiring for\b|\b(?:need|needs|looking|want|wants|trying|plan(?:ning)?) to hire\b|\bwe(?:'re| are) hiring\b|\bi (?:own|run|manage) (?:a|an|the|my) (?:\w+ )?(?:business|company|restaurant|shop|store|firm|practice|clinic|farm|bakery|cafe|salon)\b/i.test(text)) out.audience = 'employer';
  else if (/\b(?:want|wants|need|needs|looking for) (?:a |an )?(?:better|new|different|another|higher-paying|better-paying)[- ]?(?:paying )?(?:job|work|career|position)\b|\b(looking for (?:a )?(?:work|job)|need(?:s)? (?:a )?(?:job|work)|find (?:me |her |him |them )?a job|job hunting|helping (a|an|someone|my))\b/i.test(text) || out.employmentStatus === 'laid_off' || out.employmentStatus === 'unemployed') out.audience = 'job_seeker';

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
): Promise<{ updates: ContextUpdate; corrections: string[] }> {
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

    // Model output only fills gaps the rules left. A field the rules matched explicitly is not the
    // model's to reinterpret, and a fact already known may only be changed by the model when it
    // reports that field as a correction — otherwise it is echoing "Already known" or guessing.
    const corrected = new Set((data.corrections ?? []).map((c) => c.trim()));
    const merged: ContextUpdate = { ...baseline };
    const take = <K extends keyof CounselorContext>(key: K, value: CounselorContext[K] | undefined) => {
      if (value === undefined || value === null || baseline[key] !== undefined) return;
      const known = ctx[key];
      if (known !== undefined && known !== null && known !== value && !corrected.has(key)) return;
      merged[key] = value;
    };
    if (data.age != null) {
      take('age', data.age);
      if (merged.age === data.age) merged.ageBand = data.age < 18 ? 'under_18' : data.age < 25 ? '18_24' : data.age < 55 ? '25_54' : '55_plus';
    }
    // Location is only taken from the model when the message actually names a place — it otherwise
    // "remembers" or guesses one (a correction about a car once moved the person to another county).
    const namesPlace = /\bcounty\b|placer|el\s*dorado|alpine/i.test(message) || Object.keys(CITY_TO_COUNTY).some((c) => message.toLowerCase().includes(c));
    if (namesPlace) take('county', normaliseCounty(data.county));
    if (data.city && message.toLowerCase().includes(data.city.toLowerCase())) take('city', data.city.toLowerCase());
    if (data.careerInterest) {
      const cleaned = cleanInterest(data.careerInterest);
      if (cleaned.length >= 3) take('careerInterest', cleaned);
    }
    if (isOneOf(data.education, ['no_hs_diploma', 'working_on_ged', 'ged_or_hs', 'some_college', 'degree'])) take('education', data.education as CounselorContext['education']);
    if (isOneOf(data.employmentStatus, ['unemployed', 'employed', 'underemployed', 'laid_off', 'student'])) take('employmentStatus', data.employmentStatus as CounselorContext['employmentStatus']);
    if (isOneOf(data.transportation, ['own_vehicle', 'transit_only', 'none'])) take('transportation', data.transportation as CounselorContext['transportation']);
    if (isOneOf(data.incomeUrgency, ['immediate', 'can_train_first', 'flexible'])) take('incomeUrgency', data.incomeUrgency as CounselorContext['incomeUrgency']);
    if (isOneOf(data.audience, ['job_seeker', 'employer'])) take('audience', data.audience as CounselorContext['audience']);

    const valid: PopulationTag[] = [
      'former_foster_youth', 'veteran', 'youth', 'disability',
      'low_income', 'dislocated_worker', 'english_learner', 'justice_involved',
    ];
    const pops = new Set<PopulationTag>([...(baseline.population ?? [])]);
    for (const p of data.population) if (valid.includes(p as PopulationTag) && !baseline.withdrawn?.includes(p as PopulationTag)) pops.add(p as PopulationTag);
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
  updates: ContextUpdate,
): CounselorContext {
  const next: CounselorContext = { ...current };
  const { withdrawn, quals, ...fields } = updates;
  if (quals && Object.keys(quals).length) {
    // A newly stated education level replaces earlier degree statements (a correction), then facts merge by key.
    const base = { ...(current.quals ?? {}) };
    if (fields.education || Object.keys(quals).some((k) => k.startsWith('edu:'))) for (const k of Object.keys(base)) if (k.startsWith('edu:') && !(k in quals)) delete base[k];
    next.quals = { ...base, ...quals };
  } else if (fields.education && fields.education !== current.education && current.quals) {
    next.quals = Object.fromEntries(Object.entries(current.quals).filter(([k]) => !k.startsWith('edu:')));
  }
  for (const [key, value] of Object.entries(fields) as [keyof CounselorContext, unknown][]) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // A newly stated role replaces the old one (a changed career preference is a correction).
      if (key === 'occupations' || key === 'experience') {
        (next[key] as string[]) = value as string[];
        continue;
      }
      const previous = (current[key] as string[] | undefined) ?? [];
      (next[key] as string[]) = [...new Set([...previous, ...(value as string[])])].slice(0, 8);
    } else {
      (next[key] as unknown) = value;
    }
  }
  if (withdrawn?.length) next.population = next.population.filter((p) => !withdrawn.includes(p));
  // A corrected answer must not leave its old consequence behind ("no car" → "has a car").
  if (next.transportation && next.transportation !== 'none') {
    next.barriers = (next.barriers ?? []).filter((b) => b !== 'transportation');
  }
  return next;
}

/** Scalar fields whose earlier value this turn replaced — a correction, not new information. */
export function changedFields(before: CounselorContext, after: CounselorContext): string[] {
  const keys: (keyof CounselorContext)[] = ['age', 'county', 'city', 'careerInterest', 'education', 'employmentStatus', 'transportation', 'incomeUrgency', 'audience', 'rolePreference', 'occupations'];
  // A qualification fact that flips (has ↔ absent) is a correction too.
  const qualChanges = Object.keys(after.quals ?? {}).filter((k) => before.quals?.[k] && before.quals[k]!.status !== after.quals![k]!.status).map((k) => `qualification:${k}`);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return [...keys.filter((k) => before[k] !== undefined && before[k] !== null && !same(after[k], before[k])), ...qualChanges];
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
