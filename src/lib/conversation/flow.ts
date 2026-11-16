import { z } from 'zod';
import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { parseModelJson } from '../ai/json';
import { structuredTokenBudget } from '../ai/prompts';
import { changedFields, extractContext, mergeContext } from '../counselor/extract';
import { buildKnownFacts, loadPrograms, matchPrograms, rankMatches } from '../counselor/matching';
import { QUESTIONS, readyForResults, selectNextQuestion, type Question } from '../counselor/questions';
import { completeTurn, type PreparedTurn } from '../rag/generate';
import { NO_ANSWER_TEXT } from '../rag/strict';
import { cardsFromCitations, prepareGuidedResults, type Focus } from './evidence';
import { SUBJECT, type CounselorContext, type QuickReply } from '@/types/counselor';
import type { AssistantPayload, ChatTurn } from '@/types/chat';
import type { FlowPayload, FlowStage, FlowState } from '@/types/flow';

/**
 * The guided (personal) conversation turn:
 *
 *   UNDERSTAND      extract facts from the message; corrections overwrite earlier answers
 *   ACKNOWLEDGE     one or two sentences on what is new — no facts about services
 *   RETRIEVE        focused searches over the indexed, PostgreSQL-validated knowledge
 *   CLARIFY         the single most useful unanswered question (information gain, never a fixed script)
 *   UPDATE_CONTEXT  persisted per session by the caller
 *   RECOMMEND       a strictly verified, cited answer plus cards only for programs the cited chunks name
 *
 * Code decides what to ask and when to stop; the model only words the acknowledgement. Factual
 * statements reach the user only through the strict verifier.
 */

export const emptyContext = (): CounselorContext => ({ mode: 'self', population: [], barriers: [] });
export const initialFlow = (): FlowState => ({ stage: 'START', context: emptyContext(), askedQuestions: [], pendingQuestion: null });

/** Restores a stored flow, tolerating anything malformed (a bad record starts a fresh flow). */
export function readFlow(raw: unknown): FlowState {
  const r = FlowStateSchema.safeParse(raw);
  return r.success ? (r.data as FlowState) : initialFlow();
}

const FlowStateSchema = z.object({
  stage: z.enum(['START', 'DISCOVERING_NEEDS', 'CLARIFYING', 'READY_FOR_RECOMMENDATIONS', 'SHOWING_RESULTS', 'FOLLOW_UP']),
  context: z.object({ mode: z.enum(['self', 'helper']), population: z.array(z.string()), barriers: z.array(z.string()) }).passthrough(),
  askedQuestions: z.array(z.string()).max(50),
  pendingQuestion: z.string().nullable(),
});

/** The validated response contract for the structured part of every admin-chat turn. */
export const FlowPayloadSchema = z.object({
  stage: z.enum(['START', 'DISCOVERING_NEEDS', 'CLARIFYING', 'READY_FOR_RECOMMENDATIONS', 'SHOWING_RESULTS', 'FOLLOW_UP']),
  route: z.enum(['factual', 'personal', 'smalltalk']),
  question: z.string().max(400).nullable(),
  quickReplies: z.array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) })).max(4),
  knownFacts: z.record(z.string(), z.string().max(120)),
  uncertainties: z.array(z.string().max(120)).max(5),
  canShowResults: z.boolean(),
  corrections: z.array(z.string()).max(10),
});

// ───────────────────────── state machine ─────────────────────────

export type FlowEvent =
  | { type: 'LOOKUP' }
  | { type: 'ASK'; knownCount: number }
  | { type: 'READY' }
  | { type: 'RESULTS_SHOWN'; hadResults: boolean };

/** Pure transition function. Depends on what is known and shown — never on how many messages were sent. */
export function transition(stage: FlowStage, event: FlowEvent): FlowStage {
  switch (event.type) {
    case 'LOOKUP':
      return stage; // a direct factual question leaves the guided conversation where it was
    case 'ASK':
      if (stage === 'SHOWING_RESULTS' || stage === 'FOLLOW_UP') return 'FOLLOW_UP';
      return event.knownCount < 2 ? 'DISCOVERING_NEEDS' : 'CLARIFYING';
    case 'READY':
      return 'READY_FOR_RECOMMENDATIONS';
    case 'RESULTS_SHOWN':
      return event.hadResults ? 'FOLLOW_UP' : 'SHOWING_RESULTS';
  }
}

/** The user asks for results now, before every question is answered. */
export const EARLY_RESULTS =
  /\b(show|give|see|get|list|send)\b.{0,25}\b(results?|recommendations?|options|programs|services|what you (have|found|got))\b|\b(just|skip)\b.{0,25}\b(results?|recommend\w*|options)\b|\bwhat (do|would|can) you recommend\b|\brecommendations? (now|please)\b/i;
export const wantsResults = (message: string) => EARLY_RESULTS.test(message);

// ───────────────────────── facts & uncertainty ─────────────────────────

export function knownFactsRecord(ctx: CounselorContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.mode === 'helper') out.who = 'Helping someone else';
  for (const f of buildKnownFacts(ctx)) {
    const key = f.dimension === 'Population' ? 'situation' : f.key;
    out[key] = out[key] && key === 'situation' ? `${out[key]}, ${f.label}` : f.label;
  }
  if (ctx.audience) out.audience = ctx.audience === 'employer' ? 'Employer' : 'Job seeker';
  return out;
}

const UNCERTAINTY: Partial<Record<Question['id'], string>> = {
  county: 'which county',
  transportation: 'transport',
  incomeUrgency: 'whether income is needed right away',
  education: 'diploma or GED status',
  careerInterest: 'the kind of work wanted',
  employmentStatus: 'current work status',
};

export function uncertaintiesFor(ctx: CounselorContext): string[] {
  return QUESTIONS.filter((q) => UNCERTAINTY[q.id] && (!q.applicable || q.applicable(ctx)))
    .filter((q) => {
      const v = ctx[q.field];
      return v === undefined || v === null || v === 'unknown' || (Array.isArray(v) && v.length === 0);
    })
    .filter((q) => !(ctx.audience === 'employer' && q.id !== 'county'))
    .map((q) => UNCERTAINTY[q.id]!)
    .slice(0, 3);
}

// ───────────────────────── acknowledgement wording ─────────────────────────

/** Why a question matters — generic, never a claim about a specific service. */
const WHY: Record<Question['id'], string> = {
  audience: 'Services for job seekers and for employers are different.',
  county: 'Offices and providers differ by location.',
  age: 'Age can change which services are relevant.',
  education: 'Diploma or GED status can change which training options make sense.',
  careerInterest: 'Even a rough direction helps me search for the right training.',
  employmentStatus: 'Current work status can change which services apply.',
  transportation: 'Being able to reach a training site or office matters as much as the service itself.',
  incomeUrgency: 'Needing income soon points toward job-search help; having time points toward training.',
  population: 'Some services focus on particular groups.',
};

const ACK_SYSTEM = `You write the opening of a workforce counselor's reply. You have NOT looked anything up yet.

Return JSON only: {"acknowledgement": "...", "observation": "..."}
- acknowledgement: ONE short sentence recognising what the user just said (what is new, not everything). If they corrected something, say you've updated it.
- observation: ONE short sentence on what you will look for next, or why the pending question matters.

Hard rules:
- Never state facts about programs, services, providers, eligibility, costs, wages, locations, schedules or requirements. Never name a program.
- Never say anyone is eligible or qualifies.
- Do not ask a question. Do not greet. No lists.
- In HELPER mode the user is asking about someone else: say "they/them/their" (or "she/he" only if the user did), never "you".`;

const AckSchema = z.object({ acknowledgement: z.string().min(2).max(300), observation: z.string().max(300).optional().default('') });

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

async function acknowledge(args: {
  ctx: CounselorContext;
  message: string;
  newFacts: Record<string, string>;
  corrections: string[];
  next: string;
  history: { role: string; content: string }[];
}): Promise<string> {
  const fallback = `${args.corrections.length ? "Thanks — I've updated that." : 'Got it.'} ${args.next}`.trim();
  if (!hasLlm()) return fallback;
  try {
    const response = await withTimeout(
      getLlmClient().chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0.3,
        max_tokens: structuredTokenBudget(160),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ACK_SYSTEM },
          ...args.history.slice(-2).map((h) => ({ role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: h.content.slice(0, 400) })),
          {
            role: 'user',
            content: [
              `Mode: ${args.ctx.mode === 'helper' ? 'HELPER' : 'SELF'}`,
              `New this turn: ${JSON.stringify(args.newFacts)}`,
              args.corrections.length ? `Corrected: ${args.corrections.join(', ')}` : '',
              `What happens next: ${args.next}`,
              `User said: "${args.message.slice(0, 500)}"`,
            ].filter(Boolean).join('\n'),
          },
        ],
      }),
      15_000,
      'flow acknowledgement',
    );
    const data = parseModelJson(response.choices[0]?.message?.content, (v) => {
      const r = AckSchema.safeParse(v);
      return r.success ? ({ success: true, data: r.data } as const) : ({ success: false, issues: r.error.issues.map((i) => i.message) } as const);
    }, 'Flow acknowledgement');
    if (!data) return fallback;
    const safe = stripUncitedFacts(`${data.acknowledgement} ${data.observation}`.replace(/\?/g, '.'), args.message);
    return safe.length >= 8 ? safe : fallback;
  } catch (err) {
    logger.warn('Flow acknowledgement unavailable; using deterministic wording', { error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

// ───────────────────────── the turn ─────────────────────────

export type GuidedTurnInput = {
  message: string;
  history: ChatTurn[];
  flow: FlowState;
  /** The user pressed "Show results now". */
  forceResults?: boolean;
};

export type GuidedTurnOutput = {
  answer: string;
  payload: AssistantPayload;
  flow: FlowState;
  prepared: PreparedTurn | null;
  /** Internal stages traversed this turn, for logs and tests. */
  path: FlowStage[];
};

const MAX_CLARIFYING = 4;

export async function runGuidedTurn(input: GuidedTurnInput): Promise<GuidedTurnOutput> {
  const started = Date.now();
  const history = input.history.map((h) => ({ role: h.role, content: h.content }));
  const before = input.flow.context;
  const path: FlowStage[] = [input.flow.stage];

  // ── UNDERSTAND ──
  const { updates } = await extractContext(input.message, before, history);
  const ctx = mergeContext(before, updates);
  const corrections = changedFields(before, ctx);
  const beforeFacts = knownFactsRecord(before);
  const nowFacts = knownFactsRecord(ctx);
  const newFacts = Object.fromEntries(Object.entries(nowFacts).filter(([k, v]) => beforeFacts[k] !== v));
  const contextChanged = Object.keys(newFacts).length > 0;
  const hadResults = input.flow.stage === 'SHOWING_RESULTS' || input.flow.stage === 'FOLLOW_UP';

  // ── decide: one more question, or results ──
  let matches: ReturnType<typeof rankMatches> = [];
  try {
    matches = rankMatches(matchPrograms(await loadPrograms(), ctx));
  } catch (err) {
    logger.warn('Program catalogue unavailable for question selection', { error: String(err) });
  }
  const asked = input.flow.askedQuestions;
  const early = Boolean(input.forceResults) || wantsResults(input.message);
  const ready =
    early ||
    (hadResults && contextChanged) ||
    asked.length >= MAX_CLARIFYING ||
    readyForResults(ctx, matches, asked);
  // Never put the same question twice in a row: if the reply answered something else, move on to the
  // next most useful question; if nothing else is worth asking, show results rather than badger.
  const pending = input.flow.pendingQuestion;
  const fresh = ready ? null : selectNextQuestion(ctx, matches, pending ? [...asked, pending, pending] : asked);
  // …except a decisive question the reply left unanswered, which is put once more (it is the one that
  // separates job-search help from training), acknowledging what they did say first.
  const reask = !ready && !fresh && pending ? selectNextQuestion(ctx, matches, asked) : null;
  const choice = fresh ?? (reask?.question.id === pending ? reask : null);
  const subject = SUBJECT[ctx.mode];

  // ── CLARIFY ──
  if (choice) {
    const stage = transition(input.flow.stage, { type: 'ASK', knownCount: Object.keys(nowFacts).length });
    path.push(stage);
    const base = choice.question.prompt(ctx.mode, ctx).replace(/\s+/g, ' ').trim();
    const question = choice === reask ? `One thing would still help most: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
    const lead = await acknowledge({ ctx, message: input.message, newFacts, corrections, next: WHY[choice.question.id], history });
    const answer = `${lead}\n\n${question}`;
    const flow: FlowState = { stage, context: ctx, askedQuestions: [...asked, choice.question.id], pendingQuestion: choice.question.id };
    const payload = basePayload(started, {
      stage, route: 'personal', question,
      quickReplies: choice.question.quickReplies(ctx.mode),
      knownFacts: nowFacts, uncertainties: [], canShowResults: Object.keys(nowFacts).length >= 1, corrections,
    });
    return { answer, payload, flow, prepared: null, path };
  }

  // ── RETRIEVE + RECOMMEND ──
  const ready1 = transition(input.flow.stage, { type: 'READY' });
  path.push(ready1);
  // After results, a follow-up that adds nothing new is searched in its own words alongside the context.
  const extra = hadResults && !contextChanged && !early ? input.message : undefined;
  const { prepared, focuses, focusOf } = await prepareGuidedResults(ctx, input.message, extra);
  const rawAnswer = prepared.preAnswer === null ? await generate(prepared) : '';
  const done = await completeTurn(prepared, rawAnswer, prepared.diagnostics.query, started);
  const answered = done.answer !== NO_ANSWER_TEXT && done.payload.citations.length > 0;
  const stage = transition(ready1, { type: 'RESULTS_SHOWN', hadResults });
  path.push(stage);

  const uncertainties = uncertaintiesFor(ctx);
  // One refinement question at most, and only one that has not been asked twice already.
  const nextRefine = uncertainties.length ? selectNextQuestion(ctx, matches, asked) : null;
  const refine = nextRefine && uncertainties.includes(UNCERTAINTY[nextRefine.question.id] ?? '') ? nextRefine : null;
  const recommendations = answered ? await cardsFromCitations(done.payload, focusOf, ctx.mode) : [];

  // Needs that no cited passage speaks to are said plainly, rather than implied to be covered.
  const citedChunks = new Set(done.payload.citations.flatMap((c) => c.chunkIds ?? []));
  const covered = new Set([...citedChunks].map((id) => focusOf.get(id)?.key).filter(Boolean));
  const uncovered = answered ? focuses.filter((f) => !covered.has(f.key)).map((f) => f.label) : [];
  const answer = composeResults({ ctx, focuses, verified: done.answer, answered, corrections, uncertainties, uncovered, refine: refine?.question.prompt(ctx.mode, ctx) ?? null });
  const flow: FlowState = {
    stage, context: ctx,
    askedQuestions: refine ? [...asked, refine.question.id] : asked,
    pendingQuestion: refine?.question.id ?? null,
  };
  const payload: AssistantPayload = {
    ...done.payload,
    recommendations,
    followUpSuggestions: [],
    clarifyingQuestion: null,
    profile: {},
    flow: FlowPayloadSchema.parse({
      stage, route: 'personal',
      question: refine ? refine.question.prompt(ctx.mode, ctx) : null,
      quickReplies: refine ? refine.question.quickReplies(ctx.mode) : [],
      knownFacts: nowFacts, uncertainties, canShowResults: false, corrections,
    }),
  };
  logger.info('Guided turn', { path, focuses: focuses.map((f) => f.key), answered, cards: recommendations.length, ms: Date.now() - started, subject: subject.pronoun });
  return { answer, payload, flow, prepared, path };
}

/** Deterministic lead-in + the verified answer + what is still open. Only the verified part states facts. */
export function composeResults(a: {
  ctx: CounselorContext;
  focuses: Focus[];
  verified: string;
  answered: boolean;
  corrections: string[];
  uncertainties: string[];
  /** Needs searched for that no cited passage addresses. */
  uncovered?: string[];
  refine: string | null;
}): string {
  const s = SUBJECT[a.ctx.mode];
  const join = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
  const list = join(a.focuses.map((f) => f.label)) || 'this request';
  const parts: string[] = [];
  const updated = a.corrections.length ? "Thanks — I've updated that. " : '';
  if (!a.answered) {
    parts.push(`${updated}I searched the indexed knowledge base for ${list}.`, NO_ANSWER_TEXT);
  } else {
    parts.push(`${updated}Based on what you've shared, I searched the indexed sources for ${list}. Here is what they describe:`, a.verified);
    if (a.uncovered?.length) parts.push(`I didn't find indexed information on ${join(a.uncovered)}.`);
    parts.push(`Whether ${s.pronoun} qualify for any of these is confirmed by Golden Sierra staff, not by me.`);
  }
  if (a.uncertainties.length) {
    const open = join(a.uncertainties);
    parts.push(`Still unknown: ${open}.${a.refine ? ` ${a.refine}` : ''}`);
  }
  return parts.join('\n\n');
}

function basePayload(started: number, flow: FlowPayload): AssistantPayload {
  return {
    intent: 'career_counseling',
    confidence: 0.8,
    recommendations: [],
    citations: [],
    sources: [],
    followUpSuggestions: [],
    conflicts: [],
    grounded: true, // no factual claim is made on a clarifying turn
    profile: {},
    clarifyingQuestion: flow.question,
    latencyMs: Date.now() - started,
    flow: FlowPayloadSchema.parse(flow),
  };
}

/**
 * One strict generation over the guided evidence. mercury-3 reasons before it writes, and on a
 * multi-need question that reasoning alone can exhaust the budget (finish_reason=length, empty
 * content — observed 2 in 6 runs). Low reasoning effort keeps it inside the budget; an empty reply
 * is retried once with double the budget, and anything still empty stays a refusal.
 */
async function generate(prepared: PreparedTurn): Promise<string> {
  if (!hasLlm()) return '';
  const call = async (maxTokens: number) => {
    const response = await withTimeout(
      getLlmClient().chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        messages: prepared.messages,
        reasoning_effort: 'low',
      } as Parameters<ReturnType<typeof getLlmClient>['chat']['completions']['create']>[0] & { stream?: false }),
      45_000,
      'guided answer generation',
    );
    return { text: response.choices[0]?.message?.content?.trim() ?? '', finish: response.choices[0]?.finish_reason };
  };
  try {
    const first = await call(env.LLM_MAX_TOKENS);
    if (first.text || first.finish !== 'length') return first.text;
    logger.warn('Guided answer was cut off before any text; retrying once with a larger budget');
    return (await call(env.LLM_MAX_TOKENS * 2)).text;
  } catch (err) {
    logger.error('Guided answer generation failed', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** Structured part for a turn handled by the strict factual pipeline: the guided state is left as it was. */
export function lookupFlowPayload(flow: FlowState, route: 'factual' | 'smalltalk'): FlowPayload {
  return FlowPayloadSchema.parse({
    stage: transition(flow.stage, { type: 'LOOKUP' }),
    route,
    question: null,
    quickReplies: [] as QuickReply[],
    knownFacts: knownFactsRecord(flow.context),
    uncertainties: [],
    canShowResults: flow.stage === 'DISCOVERING_NEEDS' || flow.stage === 'CLARIFYING',
    corrections: [],
  });
}
