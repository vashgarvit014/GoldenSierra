import { describe, expect, it } from 'vitest';
import { classify, classifyListing, relatedOf, skillsIn } from '@/lib/jobs/occupations';
import { segmentListings, verbatim } from '@/lib/jobs/extract';
import { listingStatus, scoreListings, type ListingRow } from '@/lib/jobs/match';
import { mergeContext, ruleExtract } from '@/lib/counselor/extract';
import { QUESTIONS, selectNextQuestion } from '@/lib/counselor/questions';
import { composeResults } from '@/lib/conversation/flow';
import type { CounselorContext } from '@/types/counselor';

const ctx = (over: Partial<CounselorContext> = {}): CounselorContext => ({ mode: 'self', population: [], barriers: [], ...over });
const listing = (over: Partial<ListingRow>): ListingRow => ({
  id: 'j', documentId: 'd', ordinal: 1, title: 'T', employer: 'E', county: 'Placer County', location: 'Auburn, CA', requiredSkills: null,
  qualifications: null, salary: null, employmentType: null, datePosted: null, deadline: null, summary: null, sourceUrl: null, applyUrl: null,
  contact: null, occupations: [], sector: null, segment: '', segmentHash: '', extractedAt: new Date(),
  document: { id: 'd', title: 'Doc', url: 'upload://x.pdf', lastVerifiedAt: null, createdAt: new Date('2026-11-13') },
  ...over,
} as ListingRow);

describe('occupation taxonomy', () => {
  it('recognises a role from a title, and from duties alone', () => {
    expect(classifyListing('Traffic Control & Lighting Technician I/II', '')).toEqual(['lighting_technician']);
    expect(classify('helped elderly people with bathing, dressing and meal preparation', 2)[0]!.key).toBe('caregiver');
    expect(classify('QuickBooks, invoices and accounts payable', 2)[0]!.key).toBe('accounting_assistant');
  });
  it('widens a role to related occupations, labelling supervisory steps', () => {
    const rel = relatedOf(['solar_installer']);
    expect([...rel.keys()]).toEqual(expect.arrayContaining(['electrician', 'electrical_technician', 'lighting_technician']));
    expect(rel.get('solar_supervisor')).toBe('supervisory');
    expect(rel.has('solar_installer')).toBe(false);
  });
  it('finds stated skills, not lookalikes', () => {
    expect(skillsIn('Experienced with QuickBooks and bookkeeping')).toEqual(expect.arrayContaining(['quickbooks', 'bookkeeping']));
    expect(skillsIn('I like music')).toEqual([]);
  });
});

describe('listing extraction', () => {
  const doc = 'S.No Job Title Employer\n1 Cook Placer County Diner\n$20/hr\n2 Electrician Sacramento\n$50/hr\nCall 3 people\n';
  it('segments by consecutive row numbers only, so one listing never absorbs another', () => {
    const seg = segmentListings(doc);
    expect(seg.map((x) => x.ordinal)).toEqual([1, 2]);
    expect(seg[0]!.text).toContain('$20/hr');
    expect(seg[0]!.text).not.toContain('$50/hr');
  });
  it('keeps a field only if it is verbatim in the segment (ignoring PDF line wraps)', () => {
    const seg = 'Flexible shifts (days/li ve-in) $23.45-$29.32/hr';
    expect(verbatim('Flexible shifts (days/live-in)', seg)).toBe('Flexible shifts (days/live-in)');
    expect(verbatim('$25/hr', seg)).toBeNull();
    expect(verbatim('Not specified', seg)).toBeNull();
  });
});

describe('role-based matching', () => {
  const rows = [
    listing({ id: 'e', title: 'Electrician', occupations: ['electrician'], sector: 'skilled_trades', county: 'Sacramento County', deadline: '2099-01-05 5:00 PM' }),
    listing({ id: 'c', title: 'In-Home Senior Care (Caregiver)', occupations: ['caregiver'], sector: 'healthcare', requiredSkills: 'bathing, dressing, meal preparation', qualifications: 'No formal eligibility listed.' }),
    listing({ id: 'x', title: 'Executive Assistant', occupations: ['executive_assistant'], sector: 'administrative', deadline: '2020-01-01', qualifications: 'HS diploma + 2 yrs experience; valid driver\'s license' }),
  ];
  it('solar experience reaches electrician as a related role (no keyword overlap), not as a role match', () => {
    const m = scoreListings(rows, mergeContext(ctx(), ruleExtract('I have experience installing solar panels and want a better job.', ctx())));
    expect(m.map((x) => `${x.kind}:${x.title}`)).toEqual(['related:Electrician']);
    expect(m[0]!.reasons[0]).toMatch(/related to solar/i);
  });
  it('duties without a title → exact caregiver match with skills alignment', () => {
    const m = scoreListings(rows, mergeContext(ctx(), ruleExtract('For five years I helped elderly people with bathing, dressing and meal preparation.', ctx())));
    expect(m[0]).toMatchObject({ kind: 'exact', title: 'In-Home Senior Care (Caregiver)' });
    expect(m[0]!.skillsAlignment).toEqual(expect.arrayContaining(['bathing', 'dressing']));
  });
  it('no related role → nothing returned (no keyword fallback that invents relevance)', () => {
    expect(scoreListings(rows, mergeContext(ctx(), ruleExtract('I want to be a deep sea saturation diver.', ctx())))).toEqual([]);
  });
  it('published requirements are compared with stated facts, and deadlines decide open/closed', () => {
    const r = scoreListings(rows, ctx({ education: 'no_hs_diploma', occupations: ['executive_assistant'] })).find((m) => m.id === 'x')!.requirements;
    expect(r.map((x) => [x.text, x.status, x.mandatory])).toEqual([
      ['HS diploma + 2 yrs experience', 'unmet', true],
      ["valid driver's license", 'unknown', true],
    ]);
    expect(listingStatus('2020-01-01').status).toBe('closed');
    expect(listingStatus('Open until filled (review 11/8/2026)').status).toBe('open_until_filled');
    expect(listingStatus(null).status).toBe('unknown');
  });
  it('closed listings rank last; a different county with no transport is an unmet requirement', () => {
    const m = scoreListings(rows, ctx({ careerInterest: 'office work', county: 'Placer', transportation: 'none', occupations: ['executive_assistant', 'electrician'] }));
    expect(m.at(-1)!.listingStatus).toBe('closed');
    expect(m.find((x) => x.id === 'e')!.access).toMatch(/^Located in Sacramento County — you said you have no reliable transportation/);
  });
});

describe('role extraction and questions', () => {
  it('separates past roles from wanted roles; a new preference replaces the old one', () => {
    expect(ruleExtract('I worked as a bookkeeper', ctx())).toMatchObject({ experience: ['accounting_assistant'] });
    expect(ruleExtract('I want to become an electrician', ctx())).toMatchObject({ occupations: ['electrician'] });
    const a = mergeContext(ctx(), ruleExtract('I want to become an electrician', ctx()));
    expect(mergeContext(a, ruleExtract('Actually I want to be a medical assistant', a)).occupations).toEqual(['medical_assistant']);
    expect(ruleExtract('I have experience installing solar panels and want a better job.', ctx()).audience).toBe('job_seeker');
    expect(ruleExtract('Supervisory or lead roles', ctx()).rolePreference).toBe('supervisory');
    expect(ruleExtract('Open to both technical and supervisory roles', ctx())).toMatchObject({ rolePreference: 'both' });
    expect(ruleExtract('Open to both technical and supervisory roles', ctx()).incomeUrgency).toBeUndefined();
  });
  it('asks about supervisory work only when a lead role exists and the listings would change', () => {
    const q = QUESTIONS.find((x) => x.id === 'rolePreference')!;
    expect(q.applicable!(ctx({ experience: ['solar_installer'] }))).toBe(true);
    expect(q.applicable!(ctx({ experience: ['caregiver'] }))).toBe(false);
    const rows = [listing({ id: 's', title: 'Crew Lead', occupations: ['solar_supervisor'] })];
    const verdicts = (c: CounselorContext) => scoreListings(rows, c).map((m) => m.id).join();
    const base = ctx({ audience: 'job_seeker', experience: ['solar_installer'], county: 'Placer', careerInterest: 'solar', incomeUrgency: 'immediate', employmentStatus: 'unemployed', education: 'ged_or_hs', transportation: 'own_vehicle', age: 30, ageBand: '25_54' });
    expect(selectNextQuestion(base, [], [], [], verdicts)?.question.id).toBe('rolePreference');
  });
});

describe('results message with job counts', () => {
  it('states real counts, keeps the no-answer sentence for services, and never claims eligibility', () => {
    const m = composeResults({ ctx: ctx(), focuses: [{ key: 'career', label: 'solar training', query: 'q' }], verified: 'x', answered: false, corrections: [], uncertainties: [], refine: null, jobs: { best: 0, related: 2, closed: 1, total: 12 } });
    expect(m).toContain('I checked the 12 indexed job listings against your role and the published requirements: none is the exact role you described with no requirement gap, 2 are related roles (1 more matched, but their deadlines have passed).');
    expect(m).toContain("I couldn't find enough information about that in the currently indexed knowledge base.");
    expect(m).toMatch(/employer to decide/);
  });
});
