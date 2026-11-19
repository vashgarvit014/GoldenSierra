import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievedSource } from '@/types/chat';
import type { FlowState } from '@/types/flow';

/** The guided turn end to end, with the model, Qdrant and PostgreSQL mocked. */

const mocks = vi.hoisted(() => ({ llm: vi.fn(), retrieve: vi.fn(), programs: vi.fn() }));

vi.mock('@/lib/ai/client', () => ({ getLlmClient: () => ({ chat: { completions: { create: mocks.llm } } }) }));
vi.mock('@/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/env')>();
  return { ...real, hasLlm: () => true };
});
vi.mock('@/lib/rag/retrieve', () => ({ retrieve: mocks.retrieve, buildFilters: () => ({}), verifySourcesAreLive: async (s: unknown) => s, retrieveStructuredPrograms: async () => [] }));
vi.mock('@/lib/rag/strict', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/strict')>()),
  validateChunks: async (s: RetrievedSource[]) => ({ valid: s, rejected: [] }),
}));
vi.mock('@/lib/counselor/matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/counselor/matching')>()),
  loadPrograms: async () => [],
}));
vi.mock('@/lib/db', () => ({ prisma: { program: { findMany: mocks.programs } } }));

import { initialFlow, runGuidedTurn } from '@/lib/conversation/flow';
import { runTurn } from '@/lib/counselor/engine';
import { NO_ANSWER_TEXT } from '@/lib/rag/strict';

const chunk = (id: string, title: string, text: string): RetrievedSource => ({
  chunkId: `c${id}`, documentId: `d${id}`, title, url: `https://goldensierra.example/${id}`, snippet: text, score: 0.03,
  similarity: 0.9, headingPath: null, category: null, lastVerified: null, documentType: 'WEB_PAGE', used: false,
});
const INTERNSHIP = chunk('1', 'Help for Job Seekers', 'Get a paid internship. A paid internship program designed for young adults and those in need of work experience.');
const EVENTS = chunk('2', 'Job Connections', 'Job Connections is a free monthly event where job seekers learn about careers in healthcare.');

let generation = '';
const reply = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} });
const FOSTER = "I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.";

beforeEach(() => {
  vi.clearAllMocks();
  generation = 'Job Connections is a free monthly event where job seekers learn about careers in healthcare. [2] A paid internship program is designed for young adults. [1]';
  mocks.retrieve.mockResolvedValue({ sources: [INTERNSHIP, EVENTS], vectorQueries: 1, vectorFailures: 0, filters: {}, timings: {} });
  mocks.programs.mockResolvedValue([
    { slug: 'paid-internships', name: 'Paid Internships', category: null, documents: [{ documentId: 'd1' }] },
    // Linked to the events document but never named in it: no card.
    { slug: 'hiring-events', name: 'Hiring Events', category: null, documents: [{ documentId: 'd2' }] },
    // Named in a cited chunk ("paid internship") but not linked to that document: no card.
    { slug: 'career-counseling', name: 'Paid Internship Counseling', category: null, documents: [] },
  ]);
  mocks.llm.mockImplementation(async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages[0]!.content;
    if (system.includes('You extract workforce facts')) return reply('{}');
    if (system.includes("first sentence of a workforce counselor")) {
      return reply(JSON.stringify({ lead: 'At 19 and drawn to healthcare, she has a clear place to start. Golden Sierra offers a free CNA course for foster youth.' }));
    }
    return reply(generation);
  });
});

const turn = (message: string, flow: FlowState = initialFlow(), forceResults = false) =>
  runGuidedTurn({ message, history: [], flow, forceResults });

describe('guided turn: clarification', () => {
  it('first message → acknowledgement + one question + quick replies; no uncited facts; nothing asked twice', async () => {
    const out = await turn(FOSTER);
    expect(['DISCOVERING_NEEDS', 'CLARIFYING']).toContain(out.payload.flow!.stage);
    expect(out.answer.match(/\?/g)).toHaveLength(1);
    expect(out.answer).toContain('At 19 and drawn to healthcare, she has a clear place to start.');
    expect(out.answer).not.toMatch(/CNA|offers/); // the model's invented observation was removed
    expect(out.payload.flow!.quickReplies.length).toBeGreaterThanOrEqual(2);
    expect(out.payload.flow!.quickReplies.length).toBeLessThanOrEqual(4);
    expect(out.payload.citations).toEqual([]);
    expect(out.payload.flow!.knownFacts).toMatchObject({ careerInterest: 'Healthcare', who: 'Helping someone else' });
    expect(out.flow.askedQuestions).toEqual([out.flow.pendingQuestion]);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('a reply that answers something else gets the unanswered decisive question once more, then results instead of a third ask', async () => {
    const first = await turn(FOSTER);
    const pending = first.flow.pendingQuestion!;
    const second = await turn('She has no reliable transportation and lives near Auburn.', first.flow);
    expect(second.payload.flow!.knownFacts.geography).toMatch(/Auburn/);
    if (second.flow.pendingQuestion === pending) expect(second.payload.flow!.question).toMatch(/^It would still help to know/);
    const third = await turn('She likes working with people.', second.flow);
    expect(third.flow.askedQuestions.filter((q) => q === pending).length).toBeLessThanOrEqual(2);
  });
});

describe('guided turn: recommendations', () => {
  it('early results: verified, cited answer; cards only for programs a cited chunk names, quoted from that chunk', async () => {
    const out = await turn(FOSTER, initialFlow(), true);
    expect(out.payload.flow!.stage).toBe('SHOWING_RESULTS');
    expect(out.path).toEqual(['START', 'READY_FOR_RECOMMENDATIONS', 'SHOWING_RESULTS']);
    const cited = out.payload.citations.flatMap((c) => c.chunkIds ?? []);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((id) => ['c1', 'c2'].includes(id))).toBe(true);
    expect(out.payload.recommendations.map((r) => r.name)).toEqual(['Paid Internships']);
    expect(INTERNSHIP.snippet).toContain(out.payload.recommendations[0]!.shortDescription);
    expect(out.payload.recommendations[0]!.shortDescription).toMatch(/^Get a paid internship\./); // whole sentence, first letter included
    expect(out.payload.recommendations[0]!.requiresVerification).toBe(true);
    expect(out.answer).toContain('confirmed by Golden Sierra staff');
    expect(out.payload.flow!.uncertainties.length).toBeGreaterThan(0); // early results name what is still unknown
    expect(out.answer).toMatch(/Still unknown:/);
  });

  it('unsupported model claims never reach the user: all removed → the fixed no-answer sentence, no cards', async () => {
    generation = 'Golden Sierra runs a CNA certification bootcamp that pays $500 per week. [1]';
    const out = await turn(FOSTER, initialFlow(), true);
    expect(out.answer).toContain(NO_ANSWER_TEXT);
    expect(out.answer).not.toMatch(/CNA|\$500/);
    expect(out.payload.citations).toEqual([]);
    expect(out.payload.recommendations).toEqual([]);
  });

  it('nothing relevant indexed → states the limitation and never calls the generator', async () => {
    mocks.retrieve.mockResolvedValue({ sources: [], vectorQueries: 1, vectorFailures: 0, filters: {}, timings: {} });
    const out = await turn(FOSTER, initialFlow(), true);
    expect(out.answer).toContain(NO_ANSWER_TEXT);
    const generatorCalls = mocks.llm.mock.calls.filter(([r]) => (r as { messages: { content: string }[] }).messages[0]!.content.includes('ONLY the SOURCES'));
    expect(generatorCalls).toHaveLength(0);
  });

  it('a correction after results updates context and re-runs recommendations (FOLLOW_UP)', async () => {
    const shown = await turn(`${FOSTER} She has no reliable transportation near Auburn.`, initialFlow(), true);
    expect(shown.flow.context.transportation).toBe('none');
    const corrected = await turn('Actually, she does have a car now.', shown.flow);
    expect(corrected.payload.flow!.stage).toBe('FOLLOW_UP');
    expect(corrected.payload.flow!.corrections).toEqual(['transportation']);
    expect(corrected.flow.context.transportation).toBe('own_vehicle');
    expect(corrected.flow.context.county).toBe('Placer'); // unchanged facts are kept
    expect(corrected.answer).toMatch(/^Thanks — I've updated that\./);
    expect(corrected.payload.citations.length).toBeGreaterThan(0);
  });
});

describe('public counselor (/api/session) results use the same verified pipeline', () => {
  const publicTurn = () =>
    runTurn({ message: FOSTER, context: { mode: 'helper', population: [], barriers: [] }, history: [], askedQuestions: [], forceResults: true });

  it('the message is verified and cited, sources are exactly the citations, cards only for linked programs', async () => {
    const { turn } = await publicTurn();
    expect(turn.stage).toBe('results');
    expect(turn.message).toContain('confirmed by Golden Sierra staff');
    expect(turn.sources.length).toBeGreaterThan(0);
    for (const s of turn.sources) expect(turn.message).toContain(`[${s.id}]`);
    expect(turn.sources.every((s) => [INTERNSHIP.url, EVENTS.url].includes(s.url!))).toBe(true);
    expect(turn.recommendations.map((r) => r.name)).toEqual(['Paid Internships']);
    expect(INTERNSHIP.snippet).toContain(turn.recommendations[0]!.shortDescription);
    expect(turn.recommendations[0]).toMatchObject({ state: 'needs_verification', officialUrl: INTERNSHIP.url, contactPhone: null, nextSteps: null });
  });

  it('unsupported model claims never reach the public user', async () => {
    generation = 'Golden Sierra runs a CNA certification bootcamp that pays $500 per week. [1]';
    const { turn } = await publicTurn();
    expect(turn.message).toContain(NO_ANSWER_TEXT);
    expect(turn.message).not.toMatch(/CNA|\$500|746-7722/);
    expect(turn.sources).toEqual([]);
    expect(turn.recommendations).toEqual([]);
  });
});
