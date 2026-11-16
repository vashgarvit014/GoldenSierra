import { isSmallTalk } from './strict';

/**
 * Factual lookup or personal guidance?
 *
 * The decision follows the *question being asked*, not whether the message
 * happens to contain "I" or "my":
 *
 *   "I live in Placer County. What is the office phone number?"  → factual (the question is about a fact)
 *   "Do I qualify for the Elevate scholarship?"                  → factual (answered from the published criteria)
 *   "What programs can I apply for?"                             → personal (open-ended, depends on the person)
 *   "I'm unemployed and live in Placer"                          → personal (a statement of circumstances)
 *   "Placer"  (reply to "which county?")                         → personal (answers the counselor's question)
 *
 * Factual lookups are answered straight from the indexed documents. Personal
 * turns continue through the adaptive counselor flow, which keeps asking its
 * follow-up questions.
 */

export type Route = { kind: 'smalltalk' | 'factual' | 'personal'; reason: string };

const INTERROGATIVE =
  /^\s*(?:(?:and|so|but|also)\s+)?(what|who|whom|whose|when|where|which|why|how|is|are|was|were|does|do|did|can|could|will|would|should|may|tell me|explain|describe|define|list|show me|give me)\b/i;

/** The user asks for recommendations or help that depends on who they are. */
const PERSONAL_ASK = new RegExp(
  [
    String.raw`\bhelp (?:me|us|my|our)\b`,
    String.raw`\bwhat should (?:i|we)\b`,
    String.raw`\bwhat (?:can|could|may) (?:i|we) (?:qualify|get|do|apply|receive|join|expect)\b`,
    String.raw`\b(?:what|which) (?:programs?|options?|services?|jobs?|training|courses?|resources?)\b[^?.]*\b(?:i|we|me|my|us)\b`,
    String.raw`\b(?:right|best|good|suitable|fit|fits) for (?:me|us)\b`,
    String.raw`\bfor me\b`,
    String.raw`\brecommend(?:ation)?s?\b`,
    String.raw`\bwhere (?:do|should|can) (?:i|we) (?:start|begin)\b`,
    String.raw`\bmy (?:options|choices|situation|resume|business|company|team|career|family|son|daughter)\b`,
    String.raw`\b(?:what|how) about\b`, // a conversational reply to the counselor's own question
  ].join('|'),
  'i',
);

/** A statement of the person's circumstances or need. */
const PERSONAL_STATEMENT = new RegExp(
  [
    String.raw`\b(?:i am|i'm|im|i've|i have|i need|i want|i'd like|i would like|i'm looking|looking for|help me|we need|we are|we're|we have|my (?:situation|resume|business|company|team|career|job|family))\b`,
    // Someone describing the person they are helping: "She is 19 and needs a job", "My client was laid off".
    String.raw`\b(?:she|he|they|my (?:client|son|daughter|friend|brother|sister|student))(?:'s| is| are| was| has| have| needs?| wants?| lives?| can't| cannot| doesn't| does not| hasn't| has not)\b`,
  ].join('|'),
  'i',
);

const sentencesOf = (text: string) => text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];

export function routeMessage(message: string, options: { fallback?: 'factual' | 'personal' } = {}): Route {
  const text = message.trim();
  if (isSmallTalk(text)) return { kind: 'smalltalk', reason: 'greeting or thanks' };

  // The last information-seeking sentence is what the person is actually asking.
  const question = [...sentencesOf(text)].reverse().find((s) => /\?\s*$/.test(s) || INTERROGATIVE.test(s));
  if (question) {
    if (PERSONAL_ASK.test(question)) return { kind: 'personal', reason: 'asks for help or recommendations that depend on the person' };
    return { kind: 'factual', reason: 'information-seeking question' };
  }
  if (PERSONAL_STATEMENT.test(text)) return { kind: 'personal', reason: 'states a personal circumstance or need' };
  return { kind: options.fallback ?? 'personal', reason: 'no question asked' };
}

/** Personal guidance (counselor-style) rather than a direct lookup. A bare topic ("WIOA") is treated as a lookup. */
export function isGuidanceRequest(message: string): boolean {
  return routeMessage(message, { fallback: 'factual' }).kind === 'personal';
}

/** A direct factual question the counselor flow should hand to the strict document pipeline. */
export function isFactualLookup(message: string): boolean {
  return routeMessage(message, { fallback: 'personal' }).kind === 'factual';
}
