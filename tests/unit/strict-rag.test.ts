import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER_TEXT,
  THRESHOLDS,
  contentTerms,
  isSmallTalk,
  lexicalCoverage,
  splitSentences,
  relevanceGate,
  stem,
  stemSet,
  verifyAnswer,
} from '@/lib/rag/strict';
import type { RetrievedSource } from '@/types/chat';

const src = (id: string, text: string, over: Partial<RetrievedSource> = {}): RetrievedSource => ({
  chunkId: `chunk-${id}`,
  documentId: `doc-${id}`,
  title: `Doc ${id}`,
  url: `https://site.example/${id}`,
  snippet: text,
  score: 0.03,
  similarity: 0.6,
  headingPath: null,
  category: null,
  lastVerified: null,
  documentType: 'WEB_PAGE',
  used: true,
  ...over,
});

describe('term analysis', () => {
  it('meets inflections: scholarships/scholarship, trained/training, services/service', () => {
    expect(stem('scholarships')).toBe(stem('scholarship'));
    expect(stem('training')).toBe(stem('trained'));
    expect(stem('services')).toBe(stem('service'));
    expect(stem('pays')).toBe(stem('pay'));
  });

  it('keeps the distinctive words of a question and drops scaffolding', () => {
    expect(contentTerms('What is Orbit?').map((t) => t.raw)).toEqual(['orbit']);
    expect(contentTerms('Tell me about the Cobalt Heron Apprenticeship wage').map((t) => t.raw)).toEqual(['cobalt', 'heron', 'apprenticeship', 'wage']);
    expect(contentTerms('how do I get a job').map((t) => t.raw)).toEqual(['job']);
  });

  it('coverage is the share of terms present in the passage', () => {
    const terms = contentTerms('orbit pricing plans');
    expect(lexicalCoverage(terms, stemSet('Orbit offers three pricing plans'))).toBe(1);
    expect(lexicalCoverage(terms, stemSet('Our pricing is simple'))).toBeCloseTo(1 / 3);
    expect(lexicalCoverage(terms, stemSet('Nothing relevant here'))).toBe(0);
  });
});

describe('relevance gate', () => {
  it('admits a passage that contains the question\'s terms', () => {
    const g = relevanceGate(contentTerms('what is orbit'), [src('a', 'Orbit is a platform that automates orders.')]);
    expect(g.relevant).toHaveLength(1);
  });

  it('refuses a passage that is merely semantically nearby (the base similarity of this model is high for unrelated text)', () => {
    const g = relevanceGate(contentTerms('how do vaccines work'), [src('a', 'We offer tuition help for training programs.', { similarity: 0.62 })]);
    expect(g.relevant).toHaveLength(0);
    expect(g.below.get('chunk-a')).toMatch(/covers 0%/);
  });

  it('lets a close paraphrase through with some term overlap', () => {
    const g = relevanceGate(contentTerms('can you help me pay for school'), [
      src('a', 'Tuition assistance helps participants pay for approved training.', { similarity: THRESHOLDS.semanticOverride + 0.01 }),
    ]);
    expect(g.relevant).toHaveLength(1);
  });

  it('a very close match passes on meaning alone (conversational questions share few words with answers)', () => {
    const g = relevanceGate(contentTerms('how do I actually get in touch with someone'), [src('a', 'Call our office or submit the interest form to reach staff.', { similarity: THRESHOLDS.semanticAlone + 0.01 })]);
    expect(g.relevant).toHaveLength(1);
  });

  it('middling similarity with no shared vocabulary is not enough', () => {
    const g = relevanceGate(contentTerms('what is photosynthesis'), [src('a', 'Unrelated text about hiring events.', { similarity: 0.6 })]);
    expect(g.relevant).toHaveLength(0);
  });
});

describe('routing', () => {
  it('greetings are small talk; questions are not', () => {
    for (const m of ['hi', 'Hello!', 'thanks', 'Thank you.', 'good morning']) expect(isSmallTalk(m)).toBe(true);
    for (const m of ['what is orbit', 'hi, what is orbit', 'thanks for nothing, how much is it']) expect(isSmallTalk(m)).toBe(false);
  });

  it('first-person requests for help are guidance; lookups are not', () => {
    for (const m of ['I am unemployed and need training', "I'm looking for a job in Placer", 'help me with my resume', 'we need to hire welders']) expect(isGuidanceRequest(m)).toBe(true);
    for (const m of ['what is orbit', 'How much does the apprenticeship pay?', 'who runs the program', 'is Orbit a broker']) expect(isGuidanceRequest(m)).toBe(false);
  });
});

describe('answer verification', () => {
  const evidence = [
    src('1', 'The Cobalt Heron Apprenticeship pays $23.40 per hour. A new cohort starts every March. Contact Marisol Okonkwo-Reyes to reserve a seat.'),
    src('2', 'The Resume Clinic meets Thursday evenings at the Larkspur Library. Walk-ins are welcome and sessions are free.'),
  ];

  it('NO_ANSWER and empty replies become the fixed no-answer text', () => {
    expect(verifyAnswer('NO_ANSWER', evidence)).toMatchObject({ noAnswer: true, answer: NO_ANSWER_TEXT, reason: 'model_reported_no_answer' });
    expect(verifyAnswer('   ', evidence).noAnswer).toBe(true);
    expect(verifyAnswer('Some answer', []).noAnswer).toBe(true);
  });

  it('keeps supported claims and cites the chunk that supports them', () => {
    const v = verifyAnswer('The Cobalt Heron Apprenticeship pays $23.40 per hour. [1] The Resume Clinic meets Thursday evenings at the Larkspur Library. [2]', evidence);
    expect(v.noAnswer).toBe(false);
    expect(v.answer).toContain('$23.40 per hour');
    expect(v.citationMap.map((c) => c.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(v.citations.map((c) => c.url)).toEqual(['https://site.example/1', 'https://site.example/2']);
    expect(v.citationMap[0]!.chunkIds).toEqual(['chunk-1']);
  });

  it('removes a sentence whose figure appears in no retrieved chunk (no invented numbers)', () => {
    const v = verifyAnswer('The Cobalt Heron Apprenticeship pays $25.00 per hour. [1] A new cohort starts every March. [1]', evidence);
    expect(v.answer).not.toContain('25.00');
    expect(v.answer).toContain('starts every March');
    expect(v.unsupported.join(' ')).toContain('$25.00');
  });

  it('removes a claim that no chunk supports even without a number (outside knowledge)', () => {
    const v = verifyAnswer('The Cobalt Heron Apprenticeship pays $23.40 per hour. [1] Welding was invented in the nineteenth century by Nikolay Benardos. [1]', evidence);
    expect(v.answer).not.toMatch(/Benardos/);
    expect(v.unsupported.join(' ')).toMatch(/Benardos/);
  });

  it('turns an answer with nothing supported into no-answer', () => {
    const v = verifyAnswer('Orbit is a satellite launched in 1998 by a consortium of nations. [1]', evidence);
    expect(v.noAnswer).toBe(true);
    expect(v.answer).toBe(NO_ANSWER_TEXT);
    expect(v.reason).toBe('no_supported_claims');
  });

  it('re-points a wrong citation to the chunk that actually supports the claim', () => {
    const v = verifyAnswer('The Resume Clinic meets Thursday evenings at the Larkspur Library. [1]', evidence); // model cited the wrong source
    expect(v.citationMap).toHaveLength(1);
    expect(v.citationMap[0]!.documentId).toBe('doc-2');
    expect(v.answer).toMatch(/\[1\]$/); // renumbered: the only cited document is now [1]
  });

  it('attributes an uncited claim to its supporting chunk', () => {
    const v = verifyAnswer('The Cobalt Heron Apprenticeship pays $23.40 per hour.', evidence);
    expect(v.citationMap.map((c) => c.documentId)).toEqual(['doc-1']);
    expect(v.answer).toContain('[1]');
  });

  it('drops citation numbers that were never retrieved', () => {
    const v = verifyAnswer('The Cobalt Heron Apprenticeship pays $23.40 per hour. [7]', evidence);
    expect(v.answer).not.toContain('[7]');
    expect(v.citationMap.every((c) => ['doc-1', 'doc-2'].includes(c.documentId))).toBe(true);
  });

  it('a fabricated link, e-mail or phone makes the sentence unsupported', () => {
    expect(verifyAnswer('Apply at https://evil.example/apply. [1]', evidence).noAnswer).toBe(true);
    expect(verifyAnswer('Email help@evil.example for a seat. [1]', evidence).noAnswer).toBe(true);
    expect(verifyAnswer('Call (555) 010-9999 to reserve a seat. [1]', evidence).noAnswer).toBe(true);
  });

  it('consolidates several chunks of one document under one citation number', () => {
    const two = [src('1', 'Orbit places orders through your own broker account.', { chunkId: 'c-a', documentId: 'doc-x' }), src('2', 'Orbit does not hold your money or give advice.', { chunkId: 'c-b', documentId: 'doc-x' })];
    const v = verifyAnswer('Orbit places orders through your own broker account. [1] Orbit does not hold your money or give advice. [2]', two);
    expect(v.citationMap).toHaveLength(1);
    expect(v.citationMap[0]!.chunkIds.sort()).toEqual(['c-a', 'c-b']);
    expect(v.answer).not.toContain('[2]');
  });

  it('keeps list structure and connective text', () => {
    const v = verifyAnswer('Here is what the sources say:\n- The Cobalt Heron Apprenticeship pays $23.40 per hour. [1]\n- A new cohort starts every March. [1]', evidence);
    expect(v.answer.split('\n').length).toBe(3);
    expect(v.answer.split('\n')[0]).toBe('Here is what the sources say:');
  });

  it('accepts figures with thousands separators, and rejects altered ones', () => {
    const ev = [src('1', 'The wombat relocation grant provides $4,800 toward fencing for approved ranchers.')];
    expect(verifyAnswer('The wombat relocation grant provides $4,800 toward fencing. [1]', ev).noAnswer).toBe(false);
    expect(verifyAnswer('The wombat relocation grant provides $4800 toward fencing. [1]', ev).noAnswer).toBe(false); // same number, no comma
    expect(verifyAnswer('The wombat relocation grant provides $48,000 toward fencing. [1]', ev).noAnswer).toBe(true);
    expect(verifyAnswer('The wombat relocation grant provides $4,800 toward fencing. [1] It pays 15% interest. [1]', ev).unsupported.join(' ')).toContain('15%');
  });

  it('a citation marker after the full stop belongs to the sentence before it', () => {
    expect(splitSentences('The wage is $23.40 per hour. [1] Orientation is monthly. [2]')).toEqual([
      'The wage is $23.40 per hour. [1]',
      'Orientation is monthly. [2]',
    ]);
    expect(splitSentences('A first fact. A second fact. [1,2] Third.')).toEqual(['A first fact.', 'A second fact. [1,2]', 'Third.']);
  });

  it('a claim spread over several chunks is supported and cites each contributing chunk', () => {
    const two = [
      src('1', 'Orbit connects to the Zerodha broker account.', { chunkId: 'c1', documentId: 'd1' }),
      src('2', 'Currently Zerodha is the only broker supported today.', { chunkId: 'c2', documentId: 'd2' }),
    ];
    const v = verifyAnswer('Orbit connects to the only broker supported today, Zerodha. [1]', two);
    expect(v.noAnswer).toBe(false);
    expect(v.citationMap.map((c) => c.documentId).sort()).toEqual(['d1', 'd2']);
  });

  it('a claim only half-present in the evidence is not supported', () => {
    const one = [src('1', 'Orbit places orders through your Zerodha account.')];
    expect(verifyAnswer('Orbit places orders through Zerodha and also guarantees profitable returns every month. [1]', one).noAnswer).toBe(true);
  });
});

import { isFactualLookup } from '@/lib/counselor/lookup';
import { isGuidanceRequest } from '@/lib/rag/routing';
describe('public chat: lookups vs the counselor flow', () => {
  it.each(['what is orbit', 'What is Orbit?', 'How much does the apprenticeship pay?', 'who runs the program', 'Tell me about WIOA', 'Is Orbit a broker?', 'explain on-the-job training'])(
    'answers %s directly from the documents',
    (m) => expect(isFactualLookup(m)).toBe(true),
  );

  it.each([
    'I need to find a job',
    "I'm unemployed and live in Placer",
    'I want training for a new career',
    'help me with my resume',
    'what should I do next',
    'what can I qualify for',
    'yes',
    'no car',
    'hello',
    "I'm helping a young adult",
  ])('leaves %s to the counselor', (m) => expect(isFactualLookup(m)).toBe(false));
});
