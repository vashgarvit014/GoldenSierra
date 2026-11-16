import { generateAnswer } from '../rag/generate';
import { NO_ANSWER_TEXT } from '../rag/strict';
import { buildKnownFacts } from './matching';
import type { CounselorContext, CounselorTurn } from '@/types/counselor';
import type { ChatTurn } from '@/types/chat';

/**
 * Direct factual questions ("What is Orbit?", "How much does X pay?") are not
 * workforce-guidance conversations. They are answered straight from the indexed
 * documents by the same strict pipeline as the admin chat — no follow-up
 * questions, no recommendations — and the counselor flow continues untouched on
 * the next personal message.
 */

export { isFactualLookup } from '../rag/routing';

export async function lookupTurn(args: {
  message: string;
  context: CounselorContext;
  history: { role: string; content: string }[];
  askedQuestions: string[];
}): Promise<{ turn: CounselorTurn; askedQuestions: string[] }> {
  const chatHistory: ChatTurn[] = args.history.slice(-6).map((h, i) => ({
    id: `h${i}`,
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: h.content,
    createdAt: new Date().toISOString(),
  }));

  const result = await generateAnswer({ message: args.message, history: chatHistory, profile: {} });
  const answered = result.answer !== NO_ANSWER_TEXT && result.payload.citations.length > 0;

  return {
    askedQuestions: args.askedQuestions, // a lookup never consumes the counselor's question budget
    turn: {
      stage: answered ? 'results' : 'clarification',
      message: result.answer,
      nextQuestion: null,
      quickReplies: [],
      assumption: null,
      knownFacts: buildKnownFacts(args.context),
      narrowing: { candidates: null, total: null, criteria: [], explanation: '' },
      context: args.context,
      recommendations: [],
      sources: result.payload.citations.map((c) => ({ id: c.id, title: c.title, url: c.url })),
      canShowResults: false,
      grounded: true, // a refusal is an honest statement; an answer was verified claim by claim
    },
  };
}
