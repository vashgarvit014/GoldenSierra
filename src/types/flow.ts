/**
 * Structured adaptive conversation flow — the contract shared by the flow
 * engine, /api/chat and the admin chat UI. Client-safe: no server imports.
 *
 * Internal pipeline per personal turn (all inside one request):
 *   UNDERSTAND → ACKNOWLEDGE → RETRIEVE → CLARIFY → UPDATE_CONTEXT → RECOMMEND
 *
 * Conversation states (what the user experiences across turns):
 *   START → DISCOVERING_NEEDS → CLARIFYING → READY_FOR_RECOMMENDATIONS → SHOWING_RESULTS → FOLLOW_UP
 * Transitions depend on what is known and what the evidence supports — never on message counts.
 */

import type { CounselorContext, QuickReply } from './counselor';

export const FLOW_STAGES = [
  'START',
  'DISCOVERING_NEEDS',
  'CLARIFYING',
  'READY_FOR_RECOMMENDATIONS',
  'SHOWING_RESULTS',
  'FOLLOW_UP',
] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

/** Persisted per session (never in the vector store). */
export type FlowState = {
  stage: FlowStage;
  context: CounselorContext;
  /** Question ids already put to the user, so none is repeated. */
  askedQuestions: string[];
  /** The question id asked on the previous turn, if any — a reply is read against it. */
  pendingQuestion: string | null;
  /** "See Results" was pressed while a requirement-deciding detail was missing: asked once, optionally. */
  preResultsAsked?: boolean;
  /** Results were requested; the next reply (an answer, or "Show results anyway") gets them. */
  resultsRequested?: boolean;
};

/** The structured part of an assistant turn, carried in AssistantPayload.flow. */
export type FlowPayload = {
  stage: FlowStage;
  /** How this message was handled: answered from documents, or part of the guided conversation. */
  route: 'factual' | 'personal' | 'smalltalk';
  /** The single follow-up question, when one is asked (also present in the message text). */
  question: string | null;
  quickReplies: QuickReply[];
  /** Plain-language facts the user volunteered, keyed by dimension. */
  knownFacts: Record<string, string>;
  /** What is still unknown and would narrow the options — shown inside results, not as a warning card. */
  uncertainties: string[];
  /** Whether the "show results now" option is offered. */
  canShowResults: boolean;
  /** Fields the user changed on this turn. */
  corrections: string[];
};
