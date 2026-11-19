import { logger } from '../logger';
import { initialFlow, runGuidedTurn } from '../conversation/flow';
import { buildAssumptions, buildKnownFacts, buildNarrowing, loadPrograms, matchPrograms, rankMatches, totalProgramCount } from './matching';
import type { CounselorContext, CounselorTurn, ProgramMatch } from '@/types/counselor';
import type { ChatTurn } from '@/types/chat';
import type { FlowState } from '@/types/flow';
import type { JobMatch } from '@/types/navigator';

/**
 * The public counselor (/api/session) turn.
 *
 * Both chat interfaces run the same guided conversation (src/lib/conversation/flow.ts): the same
 * questions in the same order, qualification questions from published job requirements, one shared
 * voice (conversation/voice.ts), and the same verified retrieval for results. This adapter only maps
 * that turn onto the public route's response contract, so the public UI is unchanged.
 */

export type TurnInput = {
  message: string;
  context: CounselorContext;
  history: { role: string; content: string }[];
  askedQuestions: string[];
  forceResults?: boolean;
  /** Stored guided-flow state (absent for sessions started before it was kept). */
  flow?: FlowState;
};

export type TurnOutput = {
  turn: CounselorTurn;
  askedQuestions: string[];
  flow: FlowState;
};

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  // The stored guided-flow state when there is one; older sessions only kept the context and asked list.
  const flow: FlowState = input.flow ?? {
    ...initialFlow(),
    context: input.context,
    askedQuestions: input.askedQuestions,
    stage: input.askedQuestions.length ? 'CLARIFYING' : 'START',
  };
  const history: ChatTurn[] = input.history.map((h, i) => ({
    id: `h${i}`,
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: h.content,
    createdAt: new Date(0).toISOString(),
  }));

  const guided = await runGuidedTurn({ message: input.message, history, flow, forceResults: input.forceResults });
  const context = guided.flow.context;
  const f = guided.payload.flow;

  let narrowing: CounselorTurn['narrowing'] = { candidates: null, total: null, criteria: [], explanation: '' };
  let matches: ProgramMatch[] = [];
  try {
    const [programs, total] = await Promise.all([loadPrograms(), totalProgramCount()]);
    const all = matchPrograms(programs, context);
    matches = rankMatches(all);
    narrowing = buildNarrowing(context, all, total);
  } catch (err) {
    logger.warn('Program catalogue unavailable', { error: err instanceof Error ? err.message : String(err) });
  }

  const results = guided.payload.navigator?.results;
  const programCards: ProgramMatch[] = (guided.payload.recommendations ?? []).map((card, i) => ({
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
  }));
  const jobCards = results ? [...results.bestJobs, ...results.relatedJobs, ...(results.gapJobs ?? [])].map(jobCard) : [];
  const isResults = guided.flow.stage === 'SHOWING_RESULTS' || guided.flow.stage === 'FOLLOW_UP' || f?.route === 'factual' || !f?.question;

  return {
    askedQuestions: guided.flow.askedQuestions,
    flow: guided.flow,
    turn: {
      stage: isResults ? 'results' : 'clarification',
      message: guided.answer,
      nextQuestion: f?.question ?? null,
      quickReplies: f?.quickReplies ?? [],
      assumption: buildAssumptions(context, matches),
      knownFacts: buildKnownFacts(context, guided.flow.pendingQuestion ? pendingLabelFor(guided.flow.pendingQuestion) : undefined),
      narrowing,
      context,
      recommendations: [...jobCards, ...programCards],
      sources: guided.payload.citations.map((c) => ({ id: c.id, title: c.title, url: c.url })),
      canShowResults: Boolean(f?.canShowResults),
      grounded: guided.payload.grounded ?? true,
    },
  };
}

const KIND: Record<JobMatch['kind'], string> = { exact: 'Role match', related: 'Related role', transferable: 'Transferable skills', sector: 'Same field' };

/** A role-matched indexed job listing as a public result card; every field is copied from the listing. */
function jobCard(m: JobMatch): ProgramMatch {
  const url = [m.applyUrl, m.sourceUrl, m.source.url].find((u) => u && /^https?:/.test(u)) ?? null;
  const q = m.qualification;
  const status = q.unmet > 0 ? `Missing: ${q.missing.join('; ')}` : q.unknown > 0 ? `${q.unknown} published requirement${q.unknown === 1 ? '' : 's'} not confirmed yet` : null;
  return {
    id: `job-${m.id}`,
    slug: `job-${m.id}`,
    name: m.employer ? `${m.title} — ${m.employer}` : m.title,
    shortDescription: m.summary ?? [m.salary, m.location ?? m.county].filter(Boolean).join(' · '),
    state: 'needs_verification',
    reasons: m.reasons,
    openQuestions: [status, m.listingStatusLabel].filter((x): x is string => Boolean(x)),
    officialUrl: url,
    contactPhone: null,
    nextSteps: null,
    counties: m.county ? [m.county] : [],
    category: `${KIND[m.kind]} · indexed job listing`,
  };
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
    workHistory: 'Previous work',
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
