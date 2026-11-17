import { describe, expect, it } from 'vitest';
import { scoreListings, type ListingRow } from '@/lib/jobs/match';
import { parseRequirements } from '@/lib/jobs/requirements';
import { answerToPending, qualificationQuestion } from '@/lib/conversation/qualify';
import { changedFields, mergeContext, ruleExtract } from '@/lib/counselor/extract';
import type { CounselorContext } from '@/types/counselor';

/**
 * Qualification-aware matching. "REAL" fixtures copy the qualification text of indexed JobListing rows
 * verbatim (tests/integration/job-listings.test.ts checks those texts against PostgreSQL). "SYNTHETIC"
 * fixtures are invented for cases the index does not contain and are labelled as such.
 */

const base = (over: Partial<CounselorContext> = {}): CounselorContext => ({ mode: 'self', population: [], barriers: [], ...over });
const say = (ctx: CounselorContext, ...msgs: string[]) => msgs.reduce((c, m) => mergeContext(c, ruleExtract(m, c)), ctx);
const row = (id: string, title: string, occupations: string[], sector: string, qualifications: string | null, requiredSkills: string | null = null): ListingRow => ({
  id, documentId: 'd', ordinal: 1, title, employer: 'E', county: 'Placer County', location: 'Auburn, CA', requiredSkills, qualifications,
  salary: null, employmentType: null, datePosted: null, deadline: null, summary: null, sourceUrl: null, applyUrl: null, contact: null,
  occupations, sector, segment: '', segmentHash: '', extractedAt: new Date(),
  document: { id: 'd', title: 'Doc', url: 'upload://x.pdf', lastVerifiedAt: null, createdAt: new Date() },
} as ListingRow);

// REAL (indexed listings, verbatim qualification text)
const CLERK = row('clerk', 'Administrative Legal Clerk - Entry', ['clerk'], 'administrative', "2 years of clerical experience; equivalent to completion of 12th grade; may need a valid driver's license");
const CAREGIVER = row('care', 'In-Home Senior Care (Caregiver)', ['caregiver'], 'healthcare', 'No formal eligibility listed. Caregiverlist 8-hour elearning certification provided after hire.');
const ELECTRICIAN = row('elec', 'Electrician', ['electrician'], 'skilled_trades', "5-yr accredited electrical apprenticeship OR 5 yrs full-time experience as an electrician; valid CA Class C+ driver's license");
const IT = row('it', 'Information Technology Specialist - Senior', ['it_specialist'], 'technology', "2 yrs journey-level IT experience; Associate's degree in CS/IT (or equivalent experience/certs); Bachelor's desirable; may need a driver's license");
// SYNTHETIC (no indexed listing has these exact requirements)
const SYN_DEGREE = row('syn-degree', 'SYNTHETIC Staff Accountant', ['accounting_assistant'], 'administrative', "Bachelor's degree in accounting required; 1 year of bookkeeping experience");
const SYN_CNA = row('syn-cna', 'SYNTHETIC Certified Nursing Assistant', ['cna'], 'healthcare', 'Active Certified Nursing Assistant (CNA) certification required; current CPR card');

const one = (rows: ListingRow[], ctx: CounselorContext, id: string) => scoreListings(rows, ctx).find((m) => m.id === id)!;

describe('1–2. degree-required role', () => {
  const wants = base({ occupations: ['accounting_assistant'] });
  it('degree unknown → requirement is UNKNOWN (never unmet), and the next question asks for education', () => {
    const m = one([SYN_DEGREE], wants, 'syn-degree');
    expect(m.requirements[0]).toMatchObject({ status: 'unknown', mandatory: true, about: 'education' });
    expect(m.qualification.fit).toBe('incomplete');
    expect(qualificationQuestion(wants, scoreListings([SYN_DEGREE], wants), [])?.key).toBe('edu');
  });
  it('explicitly no degree → UNMET, listed as missing, ranked below a listing without the gap', () => {
    const ctx = say(wants, "I don't have a college degree.");
    const all = scoreListings([SYN_DEGREE, CLERK], { ...ctx, occupations: ['accounting_assistant', 'clerk'] });
    const syn = all.find((m) => m.id === 'syn-degree')!;
    expect(syn.requirements[0]!.status).toBe('unmet');
    expect(syn.qualification.missing).toEqual(["Bachelor's degree in accounting required"]);
    expect(all.at(-1)!.id).toBe('syn-degree');
  });
  it('a degree that can be substituted ("or equivalent experience/certs") is never unmet just because the degree is missing', () => {
    const m = one([IT], say(base({ occupations: ['it_specialist'] }), "I don't have a college degree."), 'it');
    const deg = m.requirements.find((r) => /Associate/.test(r.text))!;
    expect(deg.status).toBe('unknown');
    expect(m.requirements.find((r) => /Bachelor's desirable/.test(r.text))!.mandatory).toBe(false);
  });
});

describe('3. entry-level role without a degree requirement', () => {
  it('asks no degree question; high school meets the 12th-grade requirement; the experience requirement drives the next question', () => {
    const ctx = say(base({ occupations: ['clerk'] }), 'Highest is high school.');
    const m = one([CLERK], ctx, 'clerk');
    expect(m.requirements.find((r) => /12th grade/.test(r.text))!.status).toBe('met');
    expect(m.requirements.find((r) => /driver/.test(r.text))!.mandatory).toBe(false); // "may need"
    const q = qualificationQuestion(ctx, scoreListings([CLERK], ctx), []);
    expect(q?.key).toBe('exp:administrative');
    expect(q?.question.prompt('self', ctx)).toMatch(/years of administrative & office experience/);
  });
});

describe('4. healthcare role requiring a certificate', () => {
  const ctx = base({ mode: 'helper', occupations: ['cna'], careerInterest: 'healthcare' });
  it('unknown certificate → asks for it by name; "not yet" → unmet; "has" → met', () => {
    const q = qualificationQuestion(ctx, scoreListings([SYN_CNA], ctx), [])!;
    expect(q.key).toBe('cert:cna');
    expect(q.question.prompt('helper', ctx)).toMatch(/^Do they have a CNA certification\?/);
    const [yes, no] = q.question.quickReplies('helper');
    expect(one([SYN_CNA], say(ctx, no!.value), 'syn-cna').requirements[0]!.status).toBe('unmet');
    expect(one([SYN_CNA], say(ctx, yes!.value), 'syn-cna').requirements[0]!.status).toBe('met');
    expect(one([SYN_CNA], say(ctx, 'She is taking a CNA course right now.'), 'syn-cna').requirements[0]!.status).toBe('unmet');
    expect(one([SYN_CNA], say(ctx, 'She wants to become a CNA.'), 'syn-cna').requirements[0]!.status).toBe('unknown');
  });
  it('a certificate "provided after hire" (real caregiver listing) is a note, not a prerequisite', () => {
    const m = one([CAREGIVER], ctx, 'care');
    expect(m.requirements).toEqual([]);
    expect(m.qualification.fit).toBe('no_published_requirements');
    expect(qualificationQuestion(ctx, scoreListings([CAREGIVER], ctx), [])).toBeNull();
  });
});

describe('5. skilled trade using documented experience', () => {
  it('stated electrician years and license meet the published requirements', () => {
    const ctx = say(base(), 'I worked as an electrician for 6 years and have a valid driver\'s license.');
    const m = one([ELECTRICIAN], ctx, 'elec');
    expect(m.requirements.map((r) => r.status)).toEqual(['met', 'met']);
    expect(m.qualification.fit).toBe('meets_published');
  });
  it('related-trade experience (solar) is not treated as electrician experience', () => {
    const ctx = say(base(), 'I have 3 years of experience installing solar panels.');
    const m = one([ELECTRICIAN], ctx, 'elec');
    expect(m.kind).toBe('related');
    expect(m.requirements[0]!.status).toBe('unknown');
    expect(m.requirements[0]!.comparison).toMatch(/may or may not count/);
  });
  it('fewer stated years than required → unmet', () => {
    const ctx = say(base(), 'I worked as an electrician for 2 years.');
    expect(one([ELECTRICIAN], ctx, 'elec').requirements[0]!.status).toBe('unmet');
  });
});

describe('6. correcting education', () => {
  it('a corrected degree replaces the earlier statement and flips the requirement', () => {
    const c1 = say(base({ occupations: ['accounting_assistant'] }), "I don't have a college degree.");
    expect(one([SYN_DEGREE], c1, 'syn-degree').requirements[0]!.status).toBe('unmet');
    const c2 = say(c1, "Actually I finished my bachelor's last year.");
    expect(one([SYN_DEGREE], c2, 'syn-degree').requirements[0]!.status).toBe('met');
    expect(changedFields(c1, c2)).toEqual(['qualification:edu:bachelor']); // reported as a correction
  });
});

describe('7. results without answering', () => {
  it('"Not sure" leaves it unknown (not unmet) and the question is not repeated', () => {
    const ctx = base({ occupations: ['cna'] });
    expect(answerToPending('qual:cert:cna', 'Not sure')).toEqual({});
    expect(one([SYN_CNA], ctx, 'syn-cna').requirements[0]!.status).toBe('unknown');
    expect(qualificationQuestion(ctx, scoreListings([SYN_CNA], ctx), ['qual:cert:cna'])?.key).not.toBe('cert:cna');
  });
});

describe('8. jobs without published education requirements', () => {
  it('are not penalised for unknown education and trigger no education question', () => {
    const ctx = base({ occupations: ['caregiver', 'electrician'] });
    const all = scoreListings([CAREGIVER, ELECTRICIAN], ctx);
    expect(all.find((m) => m.id === 'care')!.qualification.unknown).toBe(0);
    const q = qualificationQuestion(ctx, all, []);
    expect(q?.key).not.toBe('edu');
  });
});

describe('9. helper and self modes', () => {
  it('questions and reply values use the right person, and the reply values are read back correctly', () => {
    for (const mode of ['self', 'helper'] as const) {
      const ctx = base({ mode, occupations: ['electrician'] });
      const q = qualificationQuestion(ctx, scoreListings([ELECTRICIAN], ctx), [])!;
      expect(q.question.prompt(mode, ctx)).toMatch(mode === 'self' ? /\byou\b/ : /\bthey\b/);
      const has = q.question.quickReplies(mode)[0]!.value;
      expect(has).toMatch(mode === 'self' ? /^I have/ : /^They have/);
      const after = mergeContext(say(ctx, has), answerToPending(q.question.id, has));
      expect(one([ELECTRICIAN], after, 'elec').requirements.some((r) => r.status === 'met')).toBe(true);
    }
  });
});

describe('parsing published requirements', () => {
  it('splits alternatives, keeps "preferred" optional, attaches "may substitute" to the previous item', () => {
    const exec = parseRequirements("5 yrs progressively responsible secretarial/admin experience (education setting preferred); 2 yrs related education may substitute 2 yrs experience; Bachelor's preferred", null);
    expect(exec.map((r) => r.mandatory)).toEqual([true, false]);
    expect(parseRequirements("1 yr supervisory experience, OR bachelor's degree in a related field, OR 1-2 yrs equivalent admin/fiscal experience", null)[0]!.alternatives).toHaveLength(3);
    expect(parseRequirements('HS diploma or equivalent', null)[0]!.alternatives[0]![0]).toMatchObject({ kind: 'education', level: 1, substitutable: false });
    expect(parseRequirements(null, "Electrical/electronic traffic-signal maintenance, IMSA certification, GIS/GPS, CA Class C driver's license").map((r) => r.text)).toEqual(['IMSA certification', "CA Class C driver's license"]);
  });
});
