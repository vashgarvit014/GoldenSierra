import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import { env, hasLlm } from '../env';
import { withTimeout } from '../errors';
import { logger } from '../logger';
import type { CounselorContext } from '@/types/counselor';

/**
 * The shared voice of both chat interfaces (public /api/session and admin /api/chat).
 *
 * Code decides WHAT is asked (flow.ts, questions.ts, qualify.ts); this module decides HOW it reads:
 * the grammatical person, one short lead-in at most, and no filler, praise, self-narration or
 * repeated openings. The model only drafts the lead-in, and every draft passes `polishLead`, which
 * also removes any sentence that would state an uncited workforce fact.
 */

// ───────────────────────── person and agreement ─────────────────────────

export type Person = {
  /** you / they / she / he */
  subj: string;
  /** Capitalised subject. */
  Subj: string;
  obj: string;
  poss: string;
  /** are / is */
  be: string;
  /** do / does */
  do: string;
  /** have / has */
  have: string;
  /** "Are you" / "Is she" */
  BeQ: string;
  /** "do you have" / "does she have" */
  doHave: string;
  /** "have you" / "has she" (perfect tense questions) */
  haveQ: string;
  /** First person for quick-reply values the user sends: "I" / "They" / "She". */
  Speaker: string;
  /** "I have" / "They have" / "She has" */
  speakerHas: string;
  /** "I don't have" / "They don't have" / "She doesn't have" */
  speakerHasNot: string;
};

/** Grammatical person for the subject of the conversation; helper mode uses the user's own he/she when given. */
export function person(ctx: Pick<CounselorContext, 'mode' | 'pronoun'>): Person {
  if (ctx.mode !== 'helper') {
    return { subj: 'you', Subj: 'You', obj: 'you', poss: 'your', be: 'are', do: 'do', have: 'have', BeQ: 'Are you', doHave: 'do you have', haveQ: 'have you', Speaker: 'I', speakerHas: 'I have', speakerHasNot: "I don't have" };
  }
  if (ctx.pronoun === 'she' || ctx.pronoun === 'he') {
    const p = ctx.pronoun;
    const S = p === 'she' ? 'She' : 'He';
    return { subj: p, Subj: S, obj: p === 'she' ? 'her' : 'him', poss: p === 'she' ? 'her' : 'his', be: 'is', do: 'does', have: 'has', BeQ: `Is ${p}`, doHave: `does ${p} have`, haveQ: `has ${p}`, Speaker: S, speakerHas: `${S} has`, speakerHasNot: `${S} doesn't have` };
  }
  return { subj: 'they', Subj: 'They', obj: 'them', poss: 'their', be: 'are', do: 'do', have: 'have', BeQ: 'Are they', doHave: 'do they have', haveQ: 'have they', Speaker: 'They', speakerHas: 'They have', speakerHasNot: "They don't have" };
}

/** "she", "he" or "they" when the user refers to the person they are helping. */
export function pronounIn(text: string): 'she' | 'he' | undefined {
  if (/\b(she|her|my (daughter|niece|sister|mother|mom|wife|girlfriend|aunt|granddaughter))\b/i.test(text)) return 'she';
  if (/\b(he|him|his|my (son|nephew|brother|father|dad|husband|boyfriend|uncle|grandson))\b/i.test(text)) return 'he';
  return undefined;
}

// ───────────────────────── lead-in ─────────────────────────

/** A sentence that asserts something about services, money, eligibility or names — not allowed without a citation. */
const FACT_WORDS = /\b(offers?|offered|provides?|provided|runs?|funds?|funded|pays?|paid|covers?|eligib\w*|qualif\w*|scholarships?|stipends?|grants?|wages?|salar\w*|certif\w*|located|requires?|required|free of charge|no cost|enrol\w*|guarantee\w*|program(me)?s? (called|named))\b/i;

/**
 * Removes any sentence that would state an uncited fact: fact words, figures/links/emails the
 * user did not write, or multi-word proper names the user did not use.
 */
export function stripUncitedFacts(text: string, userText: string): string {
  const user = userText.toLowerCase();
  const allowedName = (name: string) => user.includes(name.toLowerCase()) || /^(golden sierra|placer county|el dorado county|alpine county|el dorado)$/i.test(name);
  // Split only at sentence ends (a link like www.example.org must stay inside its sentence).
  return text.split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      if (FACT_WORDS.test(s)) return false;
      if (/https?:|www\.|@|\$/.test(s)) return false;
      for (const fig of s.match(/\d[\d,.:-]*/g) ?? []) if (!user.includes(fig.replace(/[.,:-]+$/, ''))) return false;
      const names = s.slice(1).match(/\b[A-Z][a-z]+(?:\s+(?:of|and|&)?\s*[A-Z][a-z]+)+\b/g) ?? [];
      if (names.some((n) => !allowedName(n))) return false;
      return true;
    })
    .join(' ');
}


/** Openings that add nothing: praise, stock acknowledgements, self-narration. */
const FILLER_SENTENCE = [
  /^(thanks|thank you)( so much)? for (sharing|letting me know|telling me)/i,
  /^(great|good|excellent|wonderful|perfect|awesome)( question| news| start)?[.!—-]/i,
  /^(got it|sure|absolutely|of course|okay|ok|alright|understood|noted)[.!]?$/i,
  /^i (hear|see|understand) (that )?(you|they)/i,
  /^it sounds like/i,
  /^(i'?ve|i have) (noted|recorded|updated (her|his|their|your) profile)/i,
  /^(i'?ll|i will|next,? i'?ll|now i'?ll|let me)\b/i,
  /^(that'?s|it'?s|this is) (a )?(solid|great|wonderful|meaningful|good|clear|strong|smart)\b/i,
  /\b(completely|totally|perfectly) (normal|natural|understandable)\b/i,
  /^(it'?s )?(completely )?normal to feel/i,
  /\b(you'?ve|they'?ve) got this\b/i,
];

/** Specific credentials: a lead may only name one the user did. */
const CREDENTIAL = /\b(associate|bachelor'?s?|master'?s?|doctorate|phd|ged|diploma|license|licence|certificat\w*|cna|lvn)\b/gi;

/** Praise and pep talk: dropped wherever they appear in a sentence. */
const PRAISE = /\b(solid|great|wonderful|meaningful|compassionate|excellent|fantastic|amazing|perfect|good place|impressive|exciting|rewarding|nicely)\b/i;
/** Promises and narration the conversation cannot back up. */
const PROMISE = /\b(i'?ll|i will|we'?ll|let'?s find (you )?(a|the|work|income|a job))\b/i;
/** Stock openers removed from the front of an otherwise useful sentence. */
const STOCK_PREFIX = /^(got it|understood|okay|ok|alright|sure|so|right|noted)\s*[,—–-]\s*/i;

/** Claims about the labour market or region the model cannot source. */
const UNSOURCED_CLAIM = /\b(in[- ]demand|steady demand|high demand|growing field|momentum|widely available|lots? of (jobs|openings|employers)|many employers|good pay|pays well|around (roseville|rocklin|auburn)|tech-adjacent|hurdle|settles?|clears? the|meets? the|qualif\w*|eligib\w*)\b/i;

/** Sentence-level clean-up applied to every drafted lead-in. */
export function polishLead(text: string, opts: { previous?: string[]; maxWords?: number; maxSentences?: number; greeting?: boolean; userText?: string } = {}): string {
  const maxWords = opts.maxWords ?? 24;
  const sentences = text
    .replace(/\s+/g, ' ')
    .replace(/\?/g, '.')
    .split(/(?<=[.!])\s+/)
    .map((s) => s.trim().replace(STOCK_PREFIX, ''))
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .filter(Boolean)
    .filter((s) => !FILLER_SENTENCE.some((re) => re.test(s)))
    .filter((s) => !PRAISE.test(s) && !PROMISE.test(s))
    .filter((s) => !UNSOURCED_CLAIM.test(s))
    // Real words only ("..." is not a sentence), and no credential the user never mentioned.
    .filter((s) => (s.match(/[a-z]{2,}/gi) ?? []).length >= 3)
    .filter((s) => !(s.match(CREDENTIAL) ?? []).some((c) => opts.userText !== undefined && !opts.userText.toLowerCase().includes(c.toLowerCase())));
  const kept = sentences.filter((x) => x.split(' ').length <= maxWords).slice(0, opts.maxSentences ?? 1);
  const first = kept[0] ?? '';
  if (!first) return '';
  // Never open two turns the same way.
  const opening = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, '').split(' ').slice(0, 2).join(' ');
  if (opts.previous?.some((p) => opening(p) === opening(first))) return '';
  return kept.map((x) => (/[.!]$/.test(x) ? x : `${x}.`)).join(' ');
}

const LEAD_SYSTEM = `You write the first sentence of a workforce counselor's reply. The counselor's question follows your sentence automatically — do not ask it.

Return JSON only: {"lead": "..."}

The lead is ONE short, natural sentence (6–18 words) — two only on the first reply —, or "" when there is nothing worth saying.
- React to what is NEW in the user's message, specifically and warmly, the way an experienced counselor talks.
- If they corrected something, say briefly that you've updated it.
- If they are unsure where to start, reassure them in a few words that you can help them find a starting point.
- No praise ("great", "solid", "wonderful"), no "Thanks for sharing", "I understand", "It sounds like", "Got it".
- Never narrate what you will do ("I'll look for…", "Next I'll…").
- Never state facts about jobs, demand, wages, programs, services, eligibility, places or requirements.
- Do not repeat what they said word for word, and do not open the way the previous reply opened.
- Never claim anything they did not say (e.g. experience they only want to get).

Good leads: "Caregiving it is — that gives us a clear focus." / "Being behind on rent makes the timing important." / "Five years at a register means a lot of customer-facing experience." / "Without a car, where a job is matters as much as what it is."
- FIRST REPLY of the conversation (marked below): write TWO short sentences — a brief warm greeting ("Hi, I'm really glad you reached out.") and one sentence of genuine empathy for their situation ("Looking for work while bills pile up is stressful, and you don't have to sort it out alone."). Never on later replies.
- HELPER mode: the user is asking about someone else — refer to that person as "they" (or "she"/"he" if the user did), never "you".`;

/** Used when the model's first-reply greeting is unusable: the conversation still opens warmly. */
const FIRST_FALLBACK = {
  self: "Hi, I'm glad you reached out. Let's work through this together.",
  helper: "Hi, I'm glad you reached out on their behalf. Let's work through this together.",
} as const;

const LeadSchema = z.object({ lead: z.string().max(300).optional().default('') });

/**
 * One short lead-in for a clarifying turn, or '' when nothing was worth acknowledging.
 * Deterministic fallback: a correction is confirmed; anything else goes straight to the question.
 */
export async function leadIn(args: {
  ctx: CounselorContext;
  message: string;
  newFacts: Record<string, string>;
  corrections: string[];
  history: { role: string; content: string }[];
  /** Why the coming question matters — context for the model only. */
  why?: string;
}): Promise<string> {
  const previous = args.history.filter((h) => h.role === 'assistant').slice(-3).map((h) => h.content);
  const first = previous.length === 0;
  const fallback = args.corrections.length ? "Thanks, I've updated that." : '';
  if (!hasLlm()) return first ? FIRST_FALLBACK[args.ctx.mode === 'helper' ? 'helper' : 'self'] : fallback;
  try {
    const response = await withTimeout(
      getLlmClient().chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0.4,
        max_tokens: structuredTokenBudget(120),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: LEAD_SYSTEM },
          {
            role: 'user',
            content: [
              `Mode: ${args.ctx.mode === 'helper' ? 'HELPER' : 'SELF'}`,
              first ? 'This is the FIRST REPLY of the conversation: greet, then empathise.' : '',
              previous.length ? `Previous reply opened: "${previous.at(-1)!.slice(0, 120)}"` : '',
              `New facts this turn: ${JSON.stringify(args.newFacts)}`,
              args.corrections.length ? `Corrected: ${args.corrections.join(', ')}` : '',
              args.why ? `The next question matters because: ${args.why}` : '',
              `User said: "${args.message.slice(0, 500)}"`,
            ].filter(Boolean).join('\n'),
          },
        ],
      }),
      12_000,
      'lead-in',
    );
    const data = parseModelJson(response.choices[0]?.message?.content, (v) => {
      const r = LeadSchema.safeParse(v);
      return r.success ? ({ success: true, data: r.data } as const) : ({ success: false, issues: r.error.issues.map((i) => i.message) } as const);
    }, 'Lead-in');
    const polished = polishLead(stripUncitedFacts(data?.lead ?? '', args.message), { previous, maxSentences: first ? 2 : 1, userText: args.message });
    return polished || (first ? FIRST_FALLBACK[args.ctx.mode === 'helper' ? 'helper' : 'self'] : fallback);
  } catch (err) {
    logger.warn('Lead-in unavailable; asking the question directly', { error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

/** A clarifying turn: optional lead-in, then the single question. */
export function clarificationText(lead: string, question: string): string {
  return lead ? `${lead} ${question}` : question;
}

/** "3 of the matching listings ask for it." in plain words. */
export function listingReason(listings: string[]): string {
  if (listings.length === 1) return `The ${listings[0]} listing asks for this.`;
  const n = listings.length;
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five'];
  return `${words[n] ?? n} of the matching job listings ask for this.`;
}
