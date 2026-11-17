import type OpenAI from 'openai';
import { getLlmClient } from './client';
import { env } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';

/**
 * Bounded answer generation for reasoning models.
 *
 * mercury-3 counts its hidden reasoning against `max_tokens`. Measured on the guided and factual
 * prompts: 900–1,950 reasoning tokens against a 2,000 budget, so a reply can come back empty or cut
 * mid-sentence with finish_reason=length (2 of 3 guided replies at default effort; 1 of 3 at low).
 *
 * Policy, in order:
 *   1. Ask with the configured reasoning effort and the answer budget plus a reasoning reserve.
 *   2. finish_reason=length (empty or truncated) → one retry with double the budget.
 *   3. Still truncated → keep only the complete sentences; they are verified like any answer.
 *   4. Still nothing → status 'empty'; callers show a fixed "couldn't produce a verified answer"
 *      message, never a guess and never a false "nothing indexed" refusal.
 * A provider that rejects `reasoning_effort` is asked once more without it.
 */

export const REASONING_RESERVE_TOKENS = 2000;

export type CompletionStatus = 'ok' | 'truncated' | 'empty' | 'error';
export type Completion = { text: string; status: CompletionStatus; attempts: number; promptTokens?: number; completionTokens?: number };

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Drops a trailing fragment: text cut off by the token limit keeps only its finished sentences. */
export function completeSentences(text: string): string {
  const t = text.trim();
  if (!t || /[.!?)\]"”]$/.test(t)) return t;
  const lastEnd = Math.max(t.lastIndexOf('. '), t.lastIndexOf('.\n'), t.lastIndexOf('? '), t.lastIndexOf('! '), t.lastIndexOf(']\n'), t.lastIndexOf('] '));
  return lastEnd < 0 ? '' : t.slice(0, lastEnd + 1).trim();
}

let effortRejected = false;

export async function completeAnswer(
  messages: Msg[],
  opts: { label: string; temperature?: number; maxTokens?: number; timeoutMs?: number } ,
): Promise<Completion> {
  const answerBudget = opts.maxTokens ?? env.LLM_MAX_TOKENS;
  let attempts = 0;
  let usage: Pick<Completion, 'promptTokens' | 'completionTokens'> = {};

  const call = async (maxTokens: number) => {
    attempts++;
    const effort = env.LLM_REASONING_EFFORT && !effortRejected ? { reasoning_effort: env.LLM_REASONING_EFFORT } : {};
    const create = (extra: object) =>
      withTimeout(
        getLlmClient().chat.completions.create({
          model: env.LLM_MODEL,
          temperature: opts.temperature ?? 0,
          max_tokens: maxTokens,
          messages,
          ...extra,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming),
        opts.timeoutMs ?? 45_000,
        opts.label,
      );
    let response;
    try {
      response = await create(effort);
    } catch (err) {
      if ('reasoning_effort' in effort && /reasoning/i.test(err instanceof Error ? err.message : String(err))) {
        effortRejected = true;
        logger.warn('Provider rejected reasoning_effort; continuing without it', { label: opts.label });
        response = await create({});
      } else throw err;
    }
    usage = { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens };
    return { text: response.choices[0]?.message?.content?.trim() ?? '', finish: response.choices[0]?.finish_reason };
  };

  try {
    const first = await call(answerBudget + REASONING_RESERVE_TOKENS);
    if (first.finish !== 'length') return { text: first.text, status: first.text ? 'ok' : 'empty', attempts, ...usage };
    logger.warn('Answer hit the token limit; retrying once with a larger budget', { label: opts.label, chars: first.text.length });
    const second = await call((answerBudget + REASONING_RESERVE_TOKENS) * 2);
    if (second.finish !== 'length' && second.text) return { text: second.text, status: 'ok', attempts, ...usage };
    const kept = completeSentences(second.text) || completeSentences(first.text);
    if (kept) return { text: kept, status: 'truncated', attempts, ...usage };
    logger.warn('Answer still empty after the retry', { label: opts.label });
    return { text: '', status: 'empty', attempts, ...usage };
  } catch (err) {
    logger.error('Answer generation failed', { label: opts.label, error: err instanceof Error ? err.message : String(err) });
    return { text: '', status: 'error', attempts, ...usage };
  }
}
