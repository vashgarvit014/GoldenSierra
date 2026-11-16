import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryAnalysis, RetrievedSource } from '@/types/chat';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  retrieve: vi.fn(),
  rerank: vi.fn(),
  stats: vi.fn(),
  llm: vi.fn(),
  profile: vi.fn(),
}));

vi.mock('@/lib/rag/understand', () => ({
  analyzeQuery: mocks.analyze,
  mergeProfile: (p: object, u: object) => ({ ...p, ...u }),
}));
vi.mock('@/lib/rag/retrieve', () => ({
  retrieve: mocks.retrieve,
  retrieveStructuredPrograms: async () => [],
  verifySourcesAreLive: async (s: unknown) => s,
  buildFilters: () => ({}),
}));
vi.mock('@/lib/rag/rerank', () => ({ rerank: mocks.rerank }));
vi.mock('@/lib/vector/qdrant', () => ({ collectionStats: mocks.stats, getQdrant: () => ({}) }));
vi.mock('@/lib/ai/client', () => ({ getLlmClient: () => ({ chat: { completions: { create: mocks.llm } } }) }));
vi.mock('@/lib/rag/strict', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/strict')>()),
  validateChunks: async (s: RetrievedSource[]) => ({ valid: s, rejected: [] }),
  profileTerms: mocks.profile,
}));

import { generateAnswer } from '@/lib/rag/generate';
import { KB_UNAVAILABLE_TEXT, NO_ANSWER_TEXT, SMALL_TALK_TEXT } from '@/lib/rag/strict';

const analysis = (over: Partial<QueryAnalysis> = {}): QueryAnalysis => ({
  intent: 'general_info', confidence: 0.8, rewrittenQuery: 'what is orbit', keywords: [], profileUpdates: {},
  missingInfo: null, isMultiPart: false, subQuestions: [], ...over,
});
const chunk = (id: string, text: string, over: Partial<RetrievedSource> = {}): RetrievedSource => ({
  chunkId: `c${id}`, documentId: `d${id}`, title: `Doc ${id}`, url: `https://orbit.example/${id}`, snippet: text, score: 0.03,
  similarity: 0.66, headingPath: null, category: null, lastVerified: null, documentType: 'WEB_PAGE', used: false, ...over,
});
const retrieval = (sources: RetrievedSource[], over: object = {}) => ({
  sources, timings: { vectorMs: 1, keywordMs: 1, totalMs: 2 }, filters: { accessLevels: ['PUBLIC'], language: 'en' },
  vectorQueries: 1, vectorFailures: 0, ...over,
});
const modelSays = (text: string) => mocks.llm.mockResolvedValue({ choices: [{ message: { content: text } }], usage: {} });
const ask = (message: string, extra: object = {}) =>
  generateAnswer({ message, history: [], profile: {} as never, ...extra });

const ORBIT = chunk('1', 'Orbit is software that takes signals from your TradingView strategy and places orders through your own Zerodha account. Orbit is not a broker and does not hold your money.');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analyze.mockResolvedValue(analysis());
  mocks.rerank.mockImplementation(async (_a: unknown, s: RetrievedSource[]) => ({ sources: s, rerankMs: 0, strategy: 'heuristic' }));
  mocks.stats.mockResolvedValue({ exists: true, vectorCount: 780 });
  mocks.profile.mockResolvedValue({ unknown: [], distinctive: ['orbit'], generic: [] });
});

describe('no evidence → fixed refusal, and the model is never asked', () => {
  it('an empty knowledge base', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([]));
    mocks.stats.mockResolvedValue({ exists: true, vectorCount: 0 });
    const r = await ask('what is orbit');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.diagnostics?.noAnswerReason).toBe('empty_knowledge_base');
    expect(mocks.llm).not.toHaveBeenCalled();
  });

  it('a missing collection counts as empty, not as a crash', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([]));
    mocks.stats.mockResolvedValue({ exists: false, vectorCount: 0 });
    expect((await ask('what is orbit')).diagnostics?.noAnswerReason).toBe('empty_knowledge_base');
  });

  it('an unreachable vector store says so honestly instead of pretending there is nothing', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([], { vectorQueries: 2, vectorFailures: 2 }));
    const r = await ask('what is orbit');
    expect(r.answer).toBe(KB_UNAVAILABLE_TEXT);
    expect(r.diagnostics?.noAnswerReason).toBe('knowledge_base_unavailable');
    expect(mocks.llm).not.toHaveBeenCalled();
  });

  it('a search that throws', async () => {
    mocks.retrieve.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await ask('what is orbit')).answer).toBe(KB_UNAVAILABLE_TEXT);
  });

  it('candidates exist but none shares the question\'s subject', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([chunk('9', 'Tuition assistance helps participants pay for approved training programs.', { similarity: 0.64 })]));
    const r = await ask('what is orbit');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.diagnostics?.noAnswerReason).toBe('no_relevant_chunk');
    expect(r.diagnostics?.candidates[0]).toMatchObject({ status: 'below_relevance' });
    expect(mocks.llm).not.toHaveBeenCalled();
  });

  it('a question about a term that exists nowhere in the knowledge base', async () => {
    mocks.analyze.mockResolvedValue(analysis({ rewrittenQuery: 'capital of france' }));
    mocks.profile.mockResolvedValue({ unknown: ['france'], distinctive: [], generic: ['capital'] });
    mocks.retrieve.mockResolvedValue(retrieval([chunk('9', 'The capital improvements committee met in France Hall.', { similarity: 0.7 })]));
    const r = await ask('capital of France');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.diagnostics?.noAnswerReason).toBe('unknown_term:france');
    expect(mocks.llm).not.toHaveBeenCalled();
  });
});

describe('an off-topic classification does not block search', () => {
  it('searches and answers a question the classifier calls off_topic', async () => {
    mocks.analyze.mockResolvedValue(analysis({ intent: 'off_topic', confidence: 0.3 }));
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is software that takes signals from your TradingView strategy and places orders through your own Zerodha account. [1]');
    const r = await ask('what is orbit');
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(r.analysis.intent).toBe('off_topic');
    expect(r.answer).toContain('TradingView');
    expect(r.payload.citations.map((c) => c.url)).toEqual(['https://orbit.example/1']);
    expect(r.payload.grounded).toBe(true);
  });

  it('searches with the user\'s own words only: no intent vocabulary, no promotional expansion', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    await ask('what is orbit');
    const [analysisArg, , options] = mocks.retrieve.mock.calls[0]!;
    expect(options.expand).toBe(false);
    expect(analysisArg.intent).toBe('off_topic'); // no category boosts or expansions apply for a generic lookup
    expect(analysisArg.keywords).toContain('orbit');
  });
});

describe('source filters and audience', () => {
  it('searches every permitted source by default and filters only when asked', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    await ask('what is orbit');
    expect(mocks.retrieve.mock.calls[0]![2].sourceIds).toBeUndefined();
    await ask('what is orbit', { sourceIds: ['src-1'] });
    expect(mocks.retrieve.mock.calls[1]![2].sourceIds).toEqual(['src-1']);
  });

  it('states in the diagnostics that audience is a preference, not a filter', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    const r = await ask('what is orbit', { profile: { audience: 'job_seeker' } });
    expect(JSON.stringify(r.diagnostics?.filters)).toMatch(/not a filter/);
  });
});

describe('the model\'s output is verified, never trusted', () => {
  it('NO_ANSWER from the model becomes the fixed sentence, with no sources attached', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('NO_ANSWER');
    const r = await ask('what is orbit pricing');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.payload.sources).toEqual([]);
    expect(r.payload.citations).toEqual([]);
    expect(r.payload.grounded).toBe(false);
  });

  it('removes sentences from outside knowledge and keeps the supported ones', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker and does not hold your money. [1] Orbit was founded in 2019 and has 40,000 users worldwide. [1]');
    const r = await ask('what is orbit');
    expect(r.answer).toContain('not a broker');
    expect(r.answer).not.toMatch(/2019|40,000/);
    expect(r.diagnostics?.unsupportedSentences.join(' ')).toMatch(/40,000/);
  });

  it('refuses entirely when the model only offers outside knowledge', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('An orbit is the curved path of a planet around a star, described by Kepler\'s laws. [1]');
    const r = await ask('what is orbit');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.diagnostics?.noAnswerReason).toBe('no_supported_claims');
  });

  it('never cites a document that was not retrieved for this response', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1] It is also regulated by the SEC. [2]');
    const r = await ask('what is orbit');
    const retrieved = new Set(r.payload.sources.map((s) => s.documentId));
    for (const c of r.payload.citations) expect(retrieved.has(c.documentId!)).toBe(true);
    expect(r.answer).not.toContain('SEC');
  });

  it('a lookup stays a lookup: no follow-up questions, program promotion or recommendations', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    const r = await ask('what is orbit');
    expect(r.payload.followUpSuggestions).toEqual([]);
    expect(r.payload.recommendations).toEqual([]);
    expect(r.payload.clarifyingQuestion).toBeNull();
    expect(mocks.llm).toHaveBeenCalledTimes(1); // the answer call only (no follow-up generation call)
  });

  it('prompts the model with the strict, source-only rules and the numbered chunks', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    await ask('what is orbit');
    const messages = mocks.llm.mock.calls[0]![0].messages as { role: string; content: string }[];
    expect(messages[0]!.content).toMatch(/ONLY the SOURCES/);
    expect(messages[0]!.content).toMatch(/NO_ANSWER/);
    expect(messages.at(-1)!.content).toContain('<source id="1"');
    expect(messages.at(-1)!.content).not.toMatch(/Golden Sierra/); // no promotional persona leaks into a lookup
  });
});

describe('conversation routing', () => {
  it('a greeting is answered without retrieval or a model call', async () => {
    const r = await ask('hello');
    expect(r.answer).toBe(SMALL_TALK_TEXT);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.llm).not.toHaveBeenCalled();
  });

  it('a follow-up is searched using the context-resolved question, not the bare pronoun', async () => {
    mocks.analyze.mockResolvedValue(analysis({ rewrittenQuery: 'how much does the Cobalt Heron Apprenticeship pay' }));
    const wage = chunk('4', 'The Cobalt Heron Apprenticeship pays $23.40 per hour.');
    mocks.retrieve.mockResolvedValue(retrieval([wage]));
    modelSays('The Cobalt Heron Apprenticeship pays $23.40 per hour. [1]');
    const r = await ask('how much does it pay?', {
      history: [
        { id: '1', role: 'user', content: 'What is the Cobalt Heron Apprenticeship?', createdAt: '' },
        { id: '2', role: 'assistant', content: 'It is a paid training pathway.', createdAt: '' },
      ],
    });
    expect(r.diagnostics?.queryTerms).toEqual(expect.arrayContaining(['cobalt', 'heron', 'apprenticeship']));
    expect(r.answer).toContain('$23.40');
  });

  it('personal-guidance requests use the guidance path (and the same evidence rule)', async () => {
    mocks.analyze.mockResolvedValue(analysis({ intent: 'find_training', rewrittenQuery: 'I need training for welding' }));
    mocks.retrieve.mockResolvedValue(retrieval([chunk('5', 'Welding training scholarships are available through the Tern program.')]));
    modelSays('NO_ANSWER');
    const r = await ask('I need training for welding');
    expect(r.diagnostics?.mode).toBe('guidance');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
  });
});

describe('one bounded repair pass when every sentence was unsupported', () => {
  const FUSED = 'Orbit places orders through Zerodha and also guarantees profitable returns every month and is regulated by the SEC. [1]';
  const CLEAN = 'Orbit places orders through your own Zerodha account. [1] Orbit is not a broker. [1]';

  it('retries once, re-verifies the retry, and answers when the retry is supported', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    mocks.llm.mockResolvedValueOnce({ choices: [{ message: { content: FUSED } }], usage: {} }).mockResolvedValueOnce({ choices: [{ message: { content: CLEAN } }], usage: {} });
    const r = await ask('what is orbit');
    expect(r.answer).toContain('Zerodha');
    expect(r.answer).not.toContain('guarantees');
    expect(r.diagnostics?.repair).toBe('recovered');
    expect(r.diagnostics?.noAnswerReason).toBeNull();
    expect(mocks.llm).toHaveBeenCalledTimes(2);
    // the retry was told what was removed
    const retryMessages = mocks.llm.mock.calls[1]![0].messages as { content: string }[];
    expect(retryMessages.at(-1)!.content).toContain('guarantees profitable returns');
  });

  it('a retry that is still unsupported stays a refusal (the verifier is not bypassed)', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays(FUSED);
    const r = await ask('what is orbit');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(r.diagnostics?.repair).toBe('failed');
    expect(mocks.llm).toHaveBeenCalledTimes(2); // never a third
  });

  it('a retry that says NO_ANSWER is a refusal', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    mocks.llm.mockResolvedValueOnce({ choices: [{ message: { content: FUSED } }], usage: {} }).mockResolvedValueOnce({ choices: [{ message: { content: 'NO_ANSWER' } }], usage: {} });
    expect((await ask('what is orbit')).answer).toBe(NO_ANSWER_TEXT);
  });

  it('is not used when the model itself reports NO_ANSWER, or when part of the answer was supported', async () => {
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('NO_ANSWER');
    await ask('what is orbit');
    expect(mocks.llm).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    mocks.analyze.mockResolvedValue(analysis());
    mocks.rerank.mockImplementation(async (_a: unknown, s: RetrievedSource[]) => ({ sources: s, rerankMs: 0, strategy: 'heuristic' }));
    mocks.stats.mockResolvedValue({ exists: true, vectorCount: 780 });
    mocks.profile.mockResolvedValue({ unknown: [], distinctive: ['orbit'], generic: [] });
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1] Orbit is regulated by the SEC. [1]');
    const r = await ask('what is orbit');
    expect(r.answer).toContain('not a broker');
    expect(mocks.llm).toHaveBeenCalledTimes(1);
  });
});

describe('the relevance model is a veto only when the deterministic evidence is weak', () => {
  const llm = (score: number) => mocks.rerank.mockImplementation(async (_a: unknown, s: RetrievedSource[]) => ({
    sources: s.map((x) => ({ ...x, llmRelevance: score })), rerankMs: 0, strategy: 'llm',
  }));

  it('a passage containing every term of the question is kept even when the scorer returns ~0 for it', async () => {
    llm(0);
    mocks.retrieve.mockResolvedValue(retrieval([ORBIT]));
    modelSays('Orbit is not a broker. [1]');
    const r = await ask('what is orbit');
    expect(r.answer).toContain('not a broker');
    expect(r.diagnostics?.noAnswerReason).toBeNull();
  });

  it('a low score still vetoes a passage that only partly matches the question', async () => {
    llm(1);
    mocks.profile.mockResolvedValue({ unknown: [], distinctive: ['renew', 'license'], generic: [] });
    mocks.retrieve.mockResolvedValue(retrieval([chunk('7', 'Commercial truck training covers license requirements for drivers.', { similarity: 0.7 })]));
    mocks.analyze.mockResolvedValue(analysis({ rewrittenQuery: 'how do I renew my license' }));
    const r = await ask('how do I renew my license');
    expect(r.answer).toBe(NO_ANSWER_TEXT);
    expect(mocks.llm).not.toHaveBeenCalled();
  });
});
