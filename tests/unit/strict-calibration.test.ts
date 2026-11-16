import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER_TEXT, contentTerms, figureSupported, figuresIn, lexicalCoverage, namedUnknowns, outsideKnowledgeBase,
  relevanceGate, stemSet, topicalTerms, verifyAnswer,
} from '@/lib/rag/strict';
import { isFactualLookup, isGuidanceRequest, routeMessage } from '@/lib/rag/routing';
import { ruleBasedAnalysis } from '@/lib/rag/understand';
import type { RetrievedSource } from '@/types/chat';

const src = (id: string, text: string, over: Partial<RetrievedSource> = {}): RetrievedSource => ({
  chunkId: `chunk-${id}`, documentId: `doc-${id}`, title: `Doc ${id}`, url: `https://site.example/${id}`, snippet: text,
  score: 0.03, similarity: 0.6, headingPath: null, category: null, lastVerified: null, documentType: 'WEB_PAGE', used: true, ...over,
});

// Real indexed passages (goldensierra.com), used verbatim.
const ELEVATE =
  'Introducing a scholarship program designed to encourage job training and employment among people who are either English language learners or low-income individuals\n\nReceive up to $1,000 when you complete job training in four semesters or less\nReceive up to another $1,000 when you obtain training-related employment';
const APPLY = 'This scholarship is only available to individuals who are either English language learners or low-income individuals. To find out if you qualify, complete the form below.';
const CONTACT =
  'Do you have a general question? Feel free to send us a message and we’ll get back to you in approximately one business day. America’s Job Center of California115 Ascot Drive # 100Roseville, CA 95661 Phone (916) 746-7722Fax (916) 746-7733 In-Person Hours Monday – Thursday 8:00am – 4:30pmAdministrative Office115 Ascot Drive # 140Roseville, CA 95661 Phone (916) 773-8540Fax (916) 771-2144';

describe('routing: factual lookup vs personal guidance', () => {
  it.each([
    'What is the phone number?',
    'I live in Placer County. What is the office phone number?',
    "I'm a veteran, do I get priority of service?",
    'Do I qualify for a training scholarship on a $40,000 income?',
    'What programs do you offer for veterans?',
    'Where is the job center?',
    'How much does the apprenticeship pay?',
    "I'm unemployed. Is there a free computer class?",
    'and what are the office hours?',
  ])('%s → factual', (m) => {
    expect(routeMessage(m).kind).toBe('factual');
    expect(isFactualLookup(m)).toBe(true);
  });

  it.each([
    'I need to find a job',
    "I'm unemployed and live in Placer",
    "I'm unemployed, live in Placer County, and want to learn a new skill. Can Golden Sierra help me?",
    'Can you help me find a job, and is there any help paying for a certification?',
    'What programs can I apply for?',
    'what can I qualify for',
    'What should I do next?',
    'How can Golden Sierra help my business hire employees?',
    'How about training?',
    'What about El Dorado County?',
    'Placer County',
    'yes',
    'no car',
  ])('%s → personal (counselor flow)', (m) => {
    expect(routeMessage(m).kind).toBe('personal');
    expect(isFactualLookup(m)).toBe(false);
  });

  it('treats a bare topic as a lookup in the chat but as an answer to the counselor in the session', () => {
    expect(isGuidanceRequest('WIOA')).toBe(false);
    expect(isFactualLookup('WIOA')).toBe(false);
  });

  it('greetings are neither', () => {
    expect(routeMessage('hello').kind).toBe('smalltalk');
  });
});

describe('intent: explicit eligibility questions', () => {
  it('beats the program noun in the same sentence', () => {
    expect(ruleBasedAnalysis('Do I qualify for a training scholarship if I make $40,000 a year?', []).intent).toBe('eligibility');
  });
});

describe('figures: numbers, units, qualifiers', () => {
  const ev = (t: string) => figuresIn(t, true);
  const ok = (claim: string, evidence: string) => figuresIn(claim).every((f) => figureSupported(f, claim, ev(evidence)));

  it('matches number words and digits both ways', () => {
    expect(ok('It takes 4 semesters.', 'in four semesters or less')).toBe(true);
    expect(ok('It takes four semesters.', 'in 4 semesters or less')).toBe(true);
    expect(ok('It takes five semesters.', 'in four semesters or less')).toBe(false);
    expect(ok('It lasts twenty-five weeks.', 'a 25 week course')).toBe(true);
  });

  it('matches percentages, dollars and formatting variants but not different values', () => {
    expect(ok('About 50 percent attend.', 'about 50% of participants attend')).toBe(true);
    expect(ok('It costs 1,000 dollars.', 'It costs $1,000.')).toBe(true);
    expect(ok('It pays $15.50 an hour.', 'Pays $15.5 per hour')).toBe(true);
    expect(ok('It costs $50.', 'Attendance is 50%')).toBe(false); // wrong unit
    expect(ok('It costs $2,000.', 'Receive up to $1,000 and another $1,000')).toBe(false); // sums are not stated
  });

  it('does not let a claim be firmer than the source ("up to" vs exact)', () => {
    const e = 'Receive up to $1,000 when you complete job training';
    expect(ok('You can receive up to $1,000.', e)).toBe(true);
    expect(ok('You receive $1,000 when you complete training.', e)).toBe(false);
    expect(ok('The exact amount is $1,000.', e)).toBe(false);
    expect(ok('You receive at least $1,000.', e)).toBe(false); // cap ≠ floor
    expect(ok('You can receive roughly $1,000.', 'You receive $1,000.')).toBe(true); // a hedge is weaker
  });

  it('finds figures in glued scraped text', () => {
    expect(ok('The center is at 115 Ascot Drive.', 'America’s Job Center of California115 Ascot Drive # 100Roseville')).toBe(true);
    expect(ok('Call (916) 746-7722.', 'Phone (916) 746-7722Fax (916) 746-7733')).toBe(true);
    expect(ok('Call (916) 746-7733.', 'Phone (916) 746-7722')).toBe(false);
  });

  it('single-digit and spelled-out counts are checked, not ignored', () => {
    expect(ok('There are 3 steps.', 'There are 5 steps.')).toBe(false);
    expect(ok('Open Monday through Thursday, 8 to 4:30.', 'Hours Monday – Thursday 8:00am – 4:30pm')).toBe(true);
  });
});

describe('paraphrase: source-supported wording passes, additions do not', () => {
  const used = [src('a', ELEVATE), src('b', APPLY), src('c', CONTACT)];

  it('keeps a faithful paraphrase of eligibility', () => {
    const v = verifyAnswer('The scholarship is open only to English language learners and low-income people. [2]', used);
    expect(v.noAnswer).toBe(false);
    expect(v.citationMap.flatMap((c) => c.chunkIds)).toContain('chunk-b');
  });

  it('keeps a paraphrase that uses synonyms (contact ↔ get in touch, send a message)', () => {
    const v = verifyAnswer('Send a message and they will get back to you in about one business day. [3]', used);
    expect(v.noAnswer).toBe(false);
  });

  it('keeps a number-word paraphrase and cites the right chunk', () => {
    const v = verifyAnswer('You can receive up to $1,000 for completing job training in 4 semesters or less. [1]', used);
    expect(v.noAnswer).toBe(false);
    expect(v.citationMap.map((c) => c.documentId)).toEqual(['doc-a']);
  });

  it('counts the site name as supported when the page comes from that site', () => {
    const page = src('c', CONTACT, { url: 'https://goldensierra.com/contact', title: 'Contact Us' });
    const ok = verifyAnswer('For Golden Sierra, you can call (916) 746-7722 for America’s Job Center of California or (916) 773-8540 for the Administrative Office. [1]', [page]);
    expect(ok.noAnswer).toBe(false);
    // …but the name alone does not excuse content the page lacks.
    const bad = verifyAnswer('Golden Sierra guarantees every applicant a union apprenticeship. [1]', [page]);
    expect(bad.noAnswer).toBe(true);
  });

  it('removes a claim that overstates the source or adds something', () => {
    const v = verifyAnswer(
      ['The scholarship is open only to English language learners and low-income people. [2]', 'Everyone who applies is guaranteed $1,000. [1]', 'Applicants earning over $40,000 are rejected. [2]'].join('\n'),
      used,
    );
    expect(v.noAnswer).toBe(false);
    expect(v.answer).not.toContain('guaranteed');
    expect(v.answer).not.toContain('$40,000');
    expect(v.unsupported.length).toBe(2);
  });

  it('refuses entirely when nothing it says is in the sources', () => {
    expect(verifyAnswer('Applicants earning over $40,000 are rejected. [2]', used).answer).toBe(NO_ANSWER_TEXT);
  });
});

describe('relevance gate: topical terms and concept matching', () => {
  const profile = { unknown: [], distinctive: ['qualify', 'scholarship'], generic: ['training', 'year'] };

  it('ignores figures and ubiquitous words when scoring a passage', () => {
    const terms = contentTerms('Do I qualify for a training scholarship if I make $40,000 a year?');
    expect(topicalTerms(terms, profile).map((t) => t.raw)).toEqual(['qualify', 'scholarship']);
    const gate = relevanceGate(terms, [src('b', APPLY, { similarity: 0.61 })], profile);
    expect(gate.relevant).toHaveLength(1);
  });

  it('never admits fewer passages than counting every term would (generic words can only help)', () => {
    // The Contact Us page matches "phone" and "job center"; "job" is ubiquitous so it is not topical, but it still counts for the page.
    const terms = contentTerms('What is the phone number for Golden Sierra Job Training Agency?');
    const contactPage = src('c', CONTACT, { url: 'https://goldensierra.com/contact', title: 'Contact Us', similarity: 0.68 });
    const withProfile = relevanceGate(terms, [contactPage], { unknown: [], distinctive: ['phone', 'number', 'golden', 'sierra'], generic: ['job', 'training', 'agency'] });
    expect(withProfile.relevant).toHaveLength(1);
  });

  it('counts a term naming the page\'s own site as covered ("Golden Sierra" on goldensierra.com)', () => {
    const terms = contentTerms('Golden Sierra phone');
    const g = relevanceGate(terms, [src('c', 'Phone (916) 746-7722', { url: 'https://goldensierra.com/contact', similarity: 0.4 })]);
    expect(g.coverage.get('chunk-c')).toBe(1);
    const other = relevanceGate(terms, [src('d', 'Phone (916) 746-7722', { url: 'https://example.org/contact', similarity: 0.4 })]);
    expect(other.coverage.get('chunk-d')).toBeCloseTo(1 / 3);
    // …but the site name alone never makes an unrelated passage relevant.
    const unrelated = relevanceGate(contentTerms('what is goldensierra'), [src('e', 'Tuition assistance helps pay for approved training.', { url: 'https://goldensierra.com/x', similarity: 0.4 })]);
    expect(unrelated.relevant).toHaveLength(0);
  });

  it('matches "get in touch" to a contact passage by meaning, not by shared words', () => {
    const terms = contentTerms('How do I get in touch with someone?');
    expect(lexicalCoverage(terms, stemSet('Contact Us. Phone (916) 746-7722'))).toBeGreaterThan(0.4);
    expect(lexicalCoverage(terms, stemSet('Quarterly budget minutes'))).toBe(0);
  });

  it('does not equate merely related words', () => {
    const t = contentTerms('email');
    expect(lexicalCoverage(t, stemSet('Phone (916) 746-7722'))).toBe(0);
  });

  it('a question about a named thing the knowledge base never mentions is outside it', () => {
    const named = namedUnknowns('What is the minimum wage in Oregon?', ['oregon']);
    expect(named).toEqual(['Oregon']);
    expect(outsideKnowledgeBase({ unknown: ['oregon'], distinctive: ['minimum', 'wage'], generic: [] }, named)).toBe(true);
    expect(outsideKnowledgeBase({ unknown: ['renew'], distinctive: ['driver', 'license'], generic: [] })).toBe(false);
  });

  it('does not treat sentence-initial or Title Case words as named things', () => {
    expect(namedUnknowns('Oregon wage?', ['oregon'])).toEqual([]);
    expect(namedUnknowns('Do You Offer Welding Classes In Placer', ['welding'])).toEqual([]);
  });
});

describe('removing unsupported claims leaves no misleading scaffolding', () => {
  const used = [src('a', ELEVATE), src('b', APPLY)];

  it('drops a list item whose heading sentence was unsupported, instead of leaving an orphan fragment', () => {
    const v = verifyAnswer(
      ['Two options fit your situation:', '1. Union apprenticeships pay the best wages in the county. This scholarship is only available to English language learners or low-income individuals. [2]', '2. The scholarship pays up to $1,000 when you complete job training. [1]'].join('\n'),
      used,
    );
    expect(v.answer).not.toContain('Union');
    expect(v.answer).not.toContain('only available'); // orphaned remainder of the removed item
    expect(v.answer).toContain('up to $1,000');
  });

  it('drops a lead-in that no longer introduces anything', () => {
    const v = verifyAnswer(['Here are the best options:', '- Welding pays $60 an hour.', 'This scholarship is only available to English language learners or low-income individuals. [2]'].join('\n'), used);
    expect(v.answer).not.toContain('Here are');
    expect(v.answer).toContain('only available');
  });

  it('keeps a lead-in that still introduces its list', () => {
    const v = verifyAnswer(['The scholarship has two parts:', '- It pays up to $1,000 when you complete job training. [1]', '- It is only available to English language learners or low-income individuals. [2]'].join('\n'), used);
    expect(v.answer).toContain('two parts:');
  });
});

import { peelGap } from '@/lib/rag/strict';

describe('statements about what the documents do not say', () => {
  const used = [src('a', ELEVATE), src('b', APPLY)];

  it('splits a fused sentence into the claim and the silence note', () => {
    const p = peelGap('According to the sources, the scholarship is only available to English language learners or low-income individuals, but they do not specify an income threshold such as $40,000 per year.');
    expect(p.claim).toBe('According to the sources, the scholarship is only available to English language learners or low-income individuals.');
    expect(p.gap).toMatch(/^They do not specify an income threshold/);
  });

  it('does not mistake a claim about the program for a gap note', () => {
    expect(peelGap('The program does not require a degree.').gap).toBeNull();
    expect(peelGap('It does not cost anything to attend.').gap).toBeNull();
    expect(peelGap('Applicants cannot apply twice.').gap).toBeNull();
  });

  it('keeps the supported claim and the honest gap note instead of refusing the whole answer', () => {
    const v = verifyAnswer(
      'According to the sources, the scholarship is only available to English language learners or low-income individuals, but they do not specify an income threshold such as $40,000 per year. [2]',
      used,
      { question: 'Do I qualify for a training scholarship if I make $40,000 a year?' },
    );
    expect(v.noAnswer).toBe(false);
    expect(v.answer).toContain('low-income individuals');
    expect(v.answer).toContain('do not specify an income threshold');
    expect(v.citations.length).toBe(1);
  });

  it('a gap note may repeat the question\'s figures but never introduces new ones', () => {
    const q = { question: 'Do I qualify if I make $40,000 a year?' };
    expect(verifyAnswer('The scholarship is only available to English language learners or low-income individuals. [2] The sources do not state an income threshold.', used, q).answer).toContain('do not state an income threshold');
    const smuggled = verifyAnswer('The scholarship is only available to English language learners or low-income individuals. [2] The sources do not mention the $55,000 limit that applies.', used, q);
    expect(smuggled.answer).not.toContain('55,000');
    expect(smuggled.unsupported.some((u) => u.includes('55,000'))).toBe(true);
  });

  it('an answer that is only a gap note is still a refusal', () => {
    const v = verifyAnswer('The sources do not specify an income threshold.', used, { question: 'what is the threshold' });
    expect(v.noAnswer).toBe(true);
    expect(v.answer).toBe(NO_ANSWER_TEXT);
  });

  it('a claim fused with a gap is still checked on its own', () => {
    const v = verifyAnswer('Everyone earning under $40,000 is automatically approved, but the sources do not specify the form.', used, { question: 'Do I qualify at $40,000?' });
    expect(v.noAnswer).toBe(true);
  });
});

import { answerTypeBoost } from '@/lib/rag/rerank';

describe('answer-type matching in ranking', () => {
  it('prefers a passage that contains the kind of thing the question asks for', () => {
    expect(answerTypeBoost('What is the phone number?', CONTACT)).toBeGreaterThan(1);
    expect(answerTypeBoost('What is the phone number?', 'Golden Sierra Job Training Agency is your local workforce partner.')).toBe(1);
    expect(answerTypeBoost('How do I get in touch?', 'Email us at help@example.org')).toBeGreaterThan(1);
    expect(answerTypeBoost('How much does it cost?', 'Receive up to $1,000')).toBeGreaterThan(1);
    expect(answerTypeBoost('Where is the job center?', 'Visit 115 Ascot Drive in Roseville')).toBeGreaterThan(1);
    expect(answerTypeBoost('What are the hours?', 'Monday – Thursday 8:00am – 4:30pm')).toBeGreaterThan(1);
  });
  it('does not change the order for questions that ask for none of these', () => {
    expect(answerTypeBoost('What is Orbit?', CONTACT)).toBe(1);
  });
});

describe('malformed citation markers', () => {
  it('a trailing comma in a marker ("[2,6,]") does not turn its digits into figures', () => {
    const used = [src('a', CONTACT), src('b', ELEVATE)];
    const v = verifyAnswer('The phone number for the Job Center is (916) 746-7722 [1,2,].', used);
    expect(v.noAnswer).toBe(false);
    expect(v.answer).not.toMatch(/\[1,2,\]/);
    expect(v.answer).toContain('746-7722');
  });
});
