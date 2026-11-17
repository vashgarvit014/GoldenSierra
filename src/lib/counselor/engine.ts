import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import { softenOverclaims } from '../rag/consolidate';
import { extractContext, mergeContext } from './extract';
import { verifiedResults } from '../conversation/flow';
import {
  buildAssumptions,
  buildKnownFacts,
  buildNarrowing,
  loadPrograms,
  matchPrograms,
  rankMatches,
  totalProgramCount,
} from './matching';
import { QUESTIONS, criteriaFor, readyForResults, selectNextQuestion } from './questions';
import type {
  CounselorContext,
  CounselorTurn,
  ProgramMatch,
  QuickReply,
} from '@/types/counselor';

/**
 * The counselor turn engine.
 *
 *   extract → match → choose the one question → write it → verify
 *
 * The division of labour is deliberate and load-bearing. Code decides *what*
 * to ask and *which* programs remain; the model only decides *how to say it*.
 * That keeps the questioning adaptive and the eligibility honest, and it means
 * a model outage degrades the wording rather than the advice.
 */

export type TurnInput = {
  message: string;
  context: CounselorContext;
  history: { role: string; content: string }[];
  askedQuestions: string[];
  /** Set when the user pressed "See Results". */
  forceResults?: boolean;
};

export type TurnOutput = {
  turn: CounselorTurn;
  askedQuestions: string[];
};

const ReplySchema = z.object({
  message: z.string().min(1).max(1200),
  quickReplies: z.array(z.string().max(40)).max(4).optional().default([]),
});

const COUNSELOR_SYSTEM = `You are a workforce counselor for Golden Sierra Job Training Agency (Placer, El Dorado and Alpine counties, California).

You are mid-conversation. Your job on this turn is to acknowledge what was just said and ask ONE question — nothing else.

## How to write

Three short beats, in this order:
1. A brief acknowledgement of what they just told you. Specific, not "Thanks for sharing".
2. One meaningful observation about what it means for their options.
3. The single question you are given, in your own natural words.

50–110 words. Warm, direct, professional. Write like a person who does this job, not a brochure.

## Hard rules

Ask ONLY the question you are given. Never add a second question.
Never list programs, services or options on this turn. You are still understanding the situation.
Never say someone is eligible, qualifies, or is approved — staff decide that.
Never invent a program, amount, deadline, phone number or requirement.
Never repeat a greeting; the conversation is already underway.
Never mention retrieval, documents, databases, matching or how you work.
Do not restate everything they have told you — acknowledge what is new.

In helper mode the user is asking on behalf of someone else: say "they" / "them", never "you".

Return JSON: {"message": "...", "quickReplies": ["...", "..."]}
quickReplies: 2–4 short plausible answers to YOUR question, 1–4 words each. Omit if the question is open-ended.`;

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const started = Date.now();

  // ── 1. Understand ──
  const { updates } = await extractContext(input.message, input.context, input.history);
  const context = mergeContext(input.context, updates);

  // ── 2. Match against the real catalogue ──
  let programs: Awaited<ReturnType<typeof loadPrograms>> = [];
  let total: number | null = null;
  try {
    [programs, total] = await Promise.all([loadPrograms(), totalProgramCount()]);
  } catch (err) {
    // A catalogue failure must not invent numbers — counts stay null.
    logger.warn('Program catalogue unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const matches = rankMatches(matchPrograms(programs, context));
  const narrowing = buildNarrowing(context, matchPrograms(programs, context), total);

  // ── 3. Decide the single next question ──
  const ready = input.forceResults || readyForResults(context, matches, input.askedQuestions, programs);
  const choice = ready ? null : selectNextQuestion(context, matches, input.askedQuestions, programs);

  // Once there is nothing useful left to ask, go straight to recommendations.
  // An intermediate "I think I have enough" turn adds a round trip, says
  // nothing, and reads as repetition when it happens twice — the brief asks
  // for recommendations as soon as the information is there.
  const stage: CounselorTurn['stage'] = choice ? 'clarification' : 'results';

  const askedQuestions = choice
    ? [...input.askedQuestions, choice.question.id]
    : input.askedQuestions;

  const assumption = buildAssumptions(context, matches);

  // ── 4. Results: the same strict, verified pipeline as the admin guided chat ──
  // Focused retrieval over PostgreSQL-validated chunks, one bounded generation, every sentence
  // verified against the chunks with citations rebuilt, cards only for catalogue programs linked
  // to a cited document that the cited chunk names. Nothing on this turn comes from the catalogue
  // text or the model's memory.
  if (stage === 'results') {
    const r = await verifiedResults({ ctx: context, message: input.message, started, corrections: [], uncertainties: [], refine: null });
    logger.debug('Counselor results', { answered: r.answered, cards: r.recommendations.length, ms: Date.now() - started });
    return {
      askedQuestions,
      turn: {
        stage,
        message: r.answer,
        nextQuestion: null,
        quickReplies: [],
        assumption,
        knownFacts: buildKnownFacts(context),
        narrowing,
        context,
        recommendations: r.recommendations.map((card, i) => ({
          id: card.slug ?? `card-${i}`,
          slug: card.slug ?? `card-${i}`,
          name: card.name,
          shortDescription: card.shortDescription,
          state: 'needs_verification' as const,
          reasons: [card.whyRelevant],
          openQuestions: [],
          officialUrl: card.officialUrl,
          contactPhone: null,
          nextSteps: null,
          counties: [],
          category: card.category,
        })),
        sources: r.done.payload.citations.map((c) => ({ id: c.id, title: c.title, url: c.url })),
        canShowResults: true,
        grounded: r.done.payload.grounded,
      },
    };
  }

  // ── 5. Write it ──
  const { message, quickReplies } = await compose({
    stage,
    context,
    userMessage: input.message,
    history: input.history,
    question: choice?.question ?? null,
    matches,
    narrowing,
  });

  const pendingLabel = choice ? pendingLabelFor(choice.question.id) : undefined;

  logger.debug('Counselor turn', {
    stage,
    question: choice?.question.id ?? null,
    gain: choice?.gain,
    candidates: narrowing.candidates,
    ms: Date.now() - started,
  });

  return {
    askedQuestions,
    turn: {
      stage,
      message: softenOverclaims(enforceSingleQuestion(message)),
      nextQuestion: choice ? choice.question.prompt(context.mode, context) : null,
      quickReplies,
      assumption,
      knownFacts: buildKnownFacts(context, pendingLabel),
      narrowing,
      context,
      recommendations: [],
      sources: [],
      canShowResults: ready || criteriaFor(context).filter((c) => c.applied).length >= 2,
      grounded: true,
    },
  };
}

// ── Composition ──────────────────────────────────────────────────────────

async function compose(args: {
  stage: CounselorTurn['stage'];
  context: CounselorContext;
  userMessage: string;
  history: { role: string; content: string }[];
  question: (typeof QUESTIONS)[number] | null;
  matches: ProgramMatch[];
  narrowing: CounselorTurn['narrowing'];
}): Promise<{ message: string; quickReplies: QuickReply[] }> {
  const { context, question } = args;

  // Deterministic quick replies — the model may suggest, but these are the
  // ones the backend knows map to real answers.
  const canonical: QuickReply[] = question ? question.quickReplies(context.mode) : [];

  if (!hasLlm()) {
    return { message: fallbackMessage(args), quickReplies: canonical };
  }

  const system = COUNSELOR_SYSTEM;
  const brief = clarificationBrief(args);

  try {
    const client = getLlmClient();
    const response = await withTimeout(
      client.chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0.35,
        max_tokens: structuredTokenBudget(400),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          ...args.history.slice(-6).map((h) => ({
            role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: h.content.slice(0, 900),
          })),
          { role: 'user', content: brief },
        ],
      }),
      30_000,
      'counselor compose',
    );

    const raw = response.choices[0]?.message?.content ?? '';
    const data = parseModelJson(
      raw,
      (value) => {
        const r = ReplySchema.safeParse(value);
        return r.success
          ? ({ success: true, data: r.data } as const)
          : ({ success: false, issues: r.error.issues.map((i) => i.message) } as const);
      },
      'Counselor compose',
    );

    if (!data) {
      // Models sometimes answer in prose despite json_object. The prose is
      // usually the reply we wanted, so salvage it rather than discarding a
      // good sentence in favour of canned wording — but only if it reads like
      // a reply and not like a JSON fragment or an apology about format.
      const prose = raw.replace(/```[a-z]*|```/gi, '').trim();
      const usable =
        prose.length > 25 &&
        prose.length < 1200 &&
        !prose.startsWith('{') &&
        !/^\s*(i (cannot|can't|am unable)|as an ai)/i.test(prose);
      return {
        message: usable ? prose : fallbackMessage(args),
        quickReplies: canonical,
      };
    }

    // Prefer the canonical replies; only use the model's when we have none,
    // and even then they must submit as real user messages.
    const replies: QuickReply[] =
      canonical.length > 0
        ? canonical
        : data.quickReplies.filter((r) => r.trim()).slice(0, 4).map((r) => ({ label: r, value: r }));

    return { message: data.message.trim(), quickReplies: replies };
  } catch (err) {
    logger.warn('Counselor composition failed; using deterministic wording', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { message: fallbackMessage(args), quickReplies: canonical };
  }
}

function clarificationBrief(args: Parameters<typeof compose>[0]): string {
  const { context, question, narrowing, userMessage } = args;
  return [
    `Mode: ${context.mode === 'helper' ? 'HELPER — the user is asking about someone else, say "they"' : 'SELF — say "you"'}`,
    `What you now know: ${JSON.stringify(stripEmpty(context))}`,
    narrowing.candidates != null
      ? `Candidate services remaining: ${narrowing.candidates} of ${narrowing.total}`
      : 'Program matching unavailable — do not mention counts',
    '',
    `They just said: "${userMessage.slice(0, 600)}"`,
    '',
    question
      ? `ASK EXACTLY THIS, in your own words: ${question.prompt(context.mode, context)}`
      : 'Acknowledge and tell them you have enough to show some options.',
  ].join('\n');
}

/** Used whenever the model is unavailable — still a usable conversation. */
function fallbackMessage(args: Parameters<typeof compose>[0]): string {
  const { context, question } = args;
  return question
    ? `Thanks — that helps. ${question.prompt(context.mode, context)}`
    : `Thanks — I think I have enough to show you some options.`;
}

/**
 * The brief allows exactly one question per turn, and prompt compliance alone
 * is not reliable enough to guarantee it. If a second question slips through,
 * keep everything up to and including the first one and drop the rest.
 */
export function enforceSingleQuestion(message: string): string {
  const marks = (message.match(/\?/g) ?? []).length;
  if (marks <= 1) return message;

  const cut = message.indexOf('?');
  const kept = message.slice(0, cut + 1).trim();
  // Only trim when what remains still reads as a complete reply.
  return kept.split(/\s+/).length >= 12 ? kept : message;
}

function pendingLabelFor(id: string): string {
  const labels: Record<string, string> = {
    audience: 'Who this is for',
    county: 'Location',
    age: 'Age',
    education: 'Education level',
    careerInterest: 'Career direction',
    employmentStatus: 'Work situation',
    transportation: 'Transport',
    incomeUrgency: 'Income urgency',
  };
  return labels[id] ?? 'More detail';
}

function stripEmpty(ctx: CounselorContext) {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
}
