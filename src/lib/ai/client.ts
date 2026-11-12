import OpenAI from 'openai';
import { env } from '../env';
import { serviceUnavailable } from '../errors';

/**
 * Both the chat model and the embedding model are reached through the
 * OpenAI-compatible protocol, which covers OpenAI, OpenRouter, Together,
 * vLLM, TEI, Ollama and most self-hosted servers. Swapping providers is a
 * change of base URL and model name in the environment — no code change.
 */

let llmClient: OpenAI | undefined;
let embeddingClient: OpenAI | undefined;

export function getLlmClient(): OpenAI {
  if (!env.LLM_API_KEY) {
    throw serviceUnavailable(
      'The assistant is not configured yet (missing LLM_API_KEY). Please contact the site administrator.',
    );
  }
  llmClient ??= new OpenAI({
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL,
    timeout: 60_000,
    maxRetries: 2,
    defaultHeaders:
      // OpenRouter attributes traffic with these; harmless elsewhere.
      env.LLM_BASE_URL.includes('openrouter.ai')
        ? { 'HTTP-Referer': env.APP_URL, 'X-Title': 'Golden Sierra Workforce Navigator' }
        : undefined,
  });
  return llmClient;
}

export function getEmbeddingClient(): OpenAI {
  const apiKey = env.EMBEDDING_API_KEY || env.LLM_API_KEY;
  if (!apiKey) {
    throw serviceUnavailable(
      'Embeddings are not configured yet (missing EMBEDDING_API_KEY). Indexing is unavailable.',
    );
  }
  embeddingClient ??= new OpenAI({
    apiKey,
    baseURL: env.EMBEDDING_BASE_URL,
    timeout: 60_000,
    maxRetries: 3,
  });
  return embeddingClient;
}

/** Reset cached clients — used by the admin config screen after a change. */
export function resetAiClients() {
  llmClient = undefined;
  embeddingClient = undefined;
}
