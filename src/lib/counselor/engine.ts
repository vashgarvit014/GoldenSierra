import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import { checkGrounding, softenOverclaims } from '../rag/consolidate';
import { retrieve, verifySourcesAreLive } from '../rag/retrieve';
import { rerank } from '../rag/rerank';
import { extractContext, mergeContext } from './extract';
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
import type { QueryAnalysis } from '@/types/chat';

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

const RESULTS_SYSTEM = `You are a workforce counselor for Golden Sierra Job Training Agency summing up for someone at the end of a short conversation.

Open with one or two sentences that reflect their actual situation back to them, then hand over to the recommendations listed beside your message — do NOT re-list the programs in your text, they are shown as cards.

Close with the single most useful next step.

Under 110 words. Never claim anyone is eligible or approved — say "may qualify", "staff can confirm". Never invent a program, amount, deadline or phone number. In helper mode say "they", not "you".

Return JSON: {"message": "...", "quickReplies": []}`;

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
  const ready = input.forceResults || readyForResults(context, matches, input.askedQuestions);
  const choice = ready ? null : selectNextQuestion(context, matches, input.askedQuestions);

  // Once there is nothing useful left to ask, go straight to recommendations.
  // An intermediate "I think I have enough" turn adds a round trip, says
  // nothing, and reads as repetition when it happens twice — the brief asks
  // for recommendations as soon as the information is there.
  const stage: CounselorTurn['stage'] = choice ? 'clarification' : 'results';

  const askedQuestions = choice
    ? [...input.askedQuestions, choice.question.id]
    : input.askedQuestions;

  // ── 4. Retrieval (only when producing results) ──
  let sources: CounselorTurn['sources'] = [];
  let evidence: Awaited<ReturnType<typeof retrieve>>['sources'] = [];
  if (stage === 'results') {
    try {
      const analysis = analysisFor(context, input.message);
      const retrieved = await retrieve(analysis, {
        county: context.county,
        audience: context.audience,
        employmentStatus: context.employmentStatus,
        careerInterests: context.careerInterest ? [context.careerInterest] : undefined,
        isVeteran: context.population.includes('veteran') || undefined,
      });
      const live = await verifySourcesAreLive(retrieved.sources);
      const { sources: ranked } = await rerank(analysis, live);
      evidence = ranked.slice(0, 6);
      sources = evidence.map((srcItem, i) => ({ id: i + 1, title: srcItem.title, url: srcItem.url }));
    } catch (err) {
      logger.warn('Retrieval failed for counselor results', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  const assumption = buildAssumptions(context, matches);
  const pendingLabel = choice ? pendingLabelFor(choice.question.id) : undefined;

  const grounding = stage === 'results' ? checkGrounding(message, evidence) : { grounded: true, issues: [], unsupportedClaims: [] };
  if (!grounding.grounded) {
    logger.warn('Counselor results failed grounding', { issues: grounding.issues.slice(0, 3) });
  }

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
      message: softenOverclaims(stage === 'clarification' ? enforceSingleQuestion(message) : message),
      nextQuestion: choice ? choice.question.prompt(context.mode, context) : null,
      quickReplies,
      assumption,
      knownFacts: buildKnownFacts(context, pendingLabel),
      narrowing,
      context,
      recommendations: stage === 'results' ? matches.slice(0, 6) : [],
      sources,
      canShowResults: ready || criteriaFor(context).filter((c) => c.applied).length >= 2,
      grounded: stage === 'results' ? grounding.grounded && evidence.length > 0 : true,
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
  const { stage, context, question } = args;

  // Deterministic quick replies — the model may suggest, but these are the
  // ones the backend knows map to real answers.
  const canonical: QuickReply[] = question ? question.quickReplies(context.mode) : [];

  if (!hasLlm()) {
    return { message: fallbackMessage(args), quickReplies: canonical };
  }

  const system = stage === 'results' ? RESULTS_SYSTEM : COUNSELOR_SYSTEM;
  const brief =
    stage === 'results'
      ? resultsBrief(args)
      : clarificationBrief(args);

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

function resultsBrief(args: Parameters<typeof compose>[0]): string {
  const { context, matches } = args;
  const top = matches.slice(0, 4).map((m) => `- ${m.name} (${m.state.replace(/_/g, ' ')})`).join('\n');
  return [
    `Mode: ${context.mode === 'helper' ? 'HELPER — say "they"' : 'SELF — say "you"'}`,
    `Their situation: ${JSON.stringify(stripEmpty(context))}`,
    '',
    'These services are being shown as cards beside your message — do NOT list them again:',
    top || '(none matched)',
    '',
    'Write the short summary and the single best next step.',
  ].join('\n');
}

/** Used whenever the model is unavailable — still a usable conversation. */
function fallbackMessage(args: Parameters<typeof compose>[0]): string {
  const { context, question, stage, matches } = args;
  const they = context.mode === 'helper' ? 'they' : 'you';

  if (stage === 'results') {
    return matches.length
      ? `Based on what you've told me, here are the services worth looking at. Golden Sierra staff can confirm what ${they} qualify for — call (916) 746-7722 or submit the interest form to get started.`
      : `I don't have enough matching information to recommend specific services yet. Golden Sierra staff can help directly — call (916) 746-7722, Monday to Thursday, 8:00am–4:30pm.`;
  }
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

/** Adapts counselor context to the shape the existing retriever expects. */
function analysisFor(context: CounselorContext, message: string): QueryAnalysis {
  const parts = [
    context.careerInterest,
    context.education === 'no_hs_diploma' || context.education === 'working_on_ged' ? 'GED high school equivalency' : null,
    context.incomeUrgency === 'immediate' ? 'job openings employment' : null,
    context.incomeUrgency === 'can_train_first' ? 'training scholarship' : null,
    context.population.includes('former_foster_youth') ? 'youth services' : null,
    context.population.includes('veteran') ? 'veteran priority of service' : null,
    context.county ? `${context.county} County` : null,
  ].filter(Boolean) as string[];

  return {
    intent: context.audience === 'employer' ? 'employer_hiring' : context.incomeUrgency === 'immediate' ? 'find_job' : 'find_training',
    confidence: 0.8,
    rewrittenQuery: parts.length ? parts.join(' ') : message,
    keywords: parts,
    profileUpdates: {},
    missingInfo: null,
    isMultiPart: false,
    subQuestions: [],
  };
}

function stripEmpty(ctx: CounselorContext) {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
}
