import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Bounded generation for reasoning models: empty and truncated replies, retries, the safe fallback. */
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/ai/client', () => ({ getLlmClient: () => ({ chat: { completions: { create: mocks.create } } }) }));

import { completeAnswer, completeSentences, REASONING_RESERVE_TOKENS } from '@/lib/ai/complete';
import { verifyAnswer, GENERATION_FAILED_TEXT, NO_ANSWER_TEXT } from '@/lib/rag/strict';
import { env } from '@/lib/env';
import type { RetrievedSource } from '@/types/chat';

const res = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const msgs = [{ role: 'user' as const, content: 'q' }];

beforeEach(() => {
  mocks.create.mockReset();
});

describe('completeAnswer', () => {
  it('a normal reply is returned after one call, with a reasoning reserve on top of the answer budget', async () => {
    mocks.create.mockResolvedValueOnce(res('Fine. [1]'));
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out).toMatchObject({ text: 'Fine. [1]', status: 'ok', attempts: 1 });
    expect(mocks.create.mock.calls[0]![0].max_tokens).toBe(env.LLM_MAX_TOKENS + REASONING_RESERVE_TOKENS);
    expect(mocks.create.mock.calls[0]![0].reasoning_effort).toBe(env.LLM_REASONING_EFFORT);
  });

  it('reasoning exhausts the budget (empty, finish=length) → one retry with double the budget', async () => {
    mocks.create.mockResolvedValueOnce(res('', 'length')).mockResolvedValueOnce(res('Recovered. [1]'));
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out).toMatchObject({ text: 'Recovered. [1]', status: 'ok', attempts: 2 });
    expect(mocks.create.mock.calls[1]![0].max_tokens).toBe(2 * (env.LLM_MAX_TOKENS + REASONING_RESERVE_TOKENS));
  });

  it('still cut off after the retry → only complete sentences are kept; never more than two calls', async () => {
    mocks.create.mockResolvedValueOnce(res('', 'length')).mockResolvedValueOnce(res('Job Connections is monthly. [2] The paid intern', 'length'));
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out).toMatchObject({ text: 'Job Connections is monthly. [2]', status: 'truncated', attempts: 2 });
  });

  it('nothing usable after the retry → empty, and the verifier shows the generation-failed text, not a false refusal', async () => {
    mocks.create.mockResolvedValue(res('', 'length'));
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out).toMatchObject({ text: '', status: 'empty', attempts: 2 });
    const used = [{ chunkId: 'c1', documentId: 'd1', title: 't', snippet: 's' } as RetrievedSource];
    expect(verifyAnswer('', used).answer).toBe(GENERATION_FAILED_TEXT);
    expect(verifyAnswer('', []).answer).toBe(NO_ANSWER_TEXT);
  });

  it('a provider error is reported, not thrown', async () => {
    mocks.create.mockImplementation(async () => {
      throw new Error('503');
    });
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out).toMatchObject({ text: '', status: 'error', attempts: 1 });
  });

  it('a provider that rejects reasoning_effort is asked again without it', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Unrecognized request argument supplied: reasoning_effort')).mockResolvedValueOnce(res('Ok.'));
    const out = await completeAnswer(msgs, { label: 't' });
    expect(out.text).toBe('Ok.');
    expect(mocks.create.mock.calls[1]![0]).not.toHaveProperty('reasoning_effort');
  });
});

describe('completeSentences', () => {
  it('keeps finished sentences and drops a trailing fragment', () => {
    expect(completeSentences('One. [1] Two is')).toBe('One. [1]');
    expect(completeSentences('All done. [3]')).toBe('All done. [3]');
    expect(completeSentences('No end at all')).toBe('');
  });
});
