import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { hasLlm } from '../env';
import { completeAnswer } from '../ai/complete';
import { extractJsonObject } from '../ai/json';
import { OCCUPATION_BY_KEY, classifyListing } from './occupations';

/**
 * Structured job listings from indexed documents that tabulate vacancies.
 *
 * 1. Detect a listing table (a header naming "Job Title" and "Employer") in an INDEXED, PUBLIC document.
 *    Documents that declare themselves synthetic or fictitious are skipped.
 * 2. Split it into one segment per listing by its row numbers (1, 2, 3 … in order). Chunk boundaries are
 *    ignored, so one listing's salary or employer can never attach to another.
 * 3. The model copies field spans out of ONE segment at a time.
 * 4. Every field is kept only if it occurs verbatim in that segment (whitespace-insensitive, because PDF
 *    extraction wraps lines mid-word); anything else is dropped, never repaired or guessed.
 */

const SYNTHETIC = /\b(synthetic|fictitious|not real golden sierra information)\b/i;
const HEADER = /job title[\s\S]{0,200}employer/i;

export type Segment = { ordinal: number; text: string };

/** One segment per numbered row; numbers must run 1, 2, 3… so stray figures cannot start a listing. */
export function segmentListings(content: string): Segment[] {
  const lines = content.split('\n');
  const starts: { line: number; n: number }[] = [];
  let expect = 1;
  lines.forEach((l, i) => {
    const m = /^(\d{1,3})\s+\S/.exec(l);
    if (m && Number(m[1]) === expect) {
      starts.push({ line: i, n: expect });
      expect++;
    }
  });
  return starts.map((s, i) => ({ ordinal: s.n, text: lines.slice(s.line, starts[i + 1]?.line ?? lines.length).join('\n').trim() }));
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** A value counts only if it is in the segment (ignoring whitespace and PDF wraps). */
export function verbatim(value: string | null | undefined, segment: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.length < 2 || /^(not specified|not available|n\/a|none|-)/i.test(v)) return null;
  return squash(segment).includes(squash(v)) ? v.replace(/\s+/g, ' ') : null;
}

/** URLs are stored without the spaces PDF extraction inserts ("caree rs/" → "careers/"). */
function verbatimUrl(value: string | null | undefined, segment: string): string | null {
  const v = verbatim(value, segment);
  if (!v) return null;
  const url = v.replace(/\s+/g, '');
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

const Fields = z.object({
  title: z.string().nullish(),
  employer: z.string().nullish(),
  county: z.string().nullish(),
  location: z.string().nullish(),
  requiredSkills: z.string().nullish(),
  qualifications: z.string().nullish(),
  salary: z.string().nullish(),
  employmentType: z.string().nullish(),
  datePosted: z.string().nullish(),
  deadline: z.string().nullish(),
  summary: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  contact: z.string().nullish(),
});

const SYSTEM = `You copy fields out of ONE job listing taken from a table. Return JSON only with keys:
title, employer, county, location, requiredSkills, qualifications, salary, employmentType, datePosted, deadline, summary, sourceUrl, applyUrl, contact.
Rules:
- COPY text exactly as it appears in the listing. Do not reword, summarize, correct spelling or combine separate places.
- summary: copy the first one or two sentences of the job description, exactly.
- sourceUrl / applyUrl: copy the URL exactly as printed (it may contain stray spaces; copy them).
- contact: copy phone numbers / emails / named contacts exactly, or null.
- Use null for anything the listing does not state, or that says "Not specified" / "Not available".`;

async function extractFields(segment: string) {
  const done = await completeAnswer(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: segment.slice(0, 6000) },
    ],
    { label: 'job listing extraction', maxTokens: 1200 },
  );
  const parsed = Fields.safeParse(extractJsonObject(done.text));
  return parsed.success ? parsed.data : null;
}

export type ExtractReport = { document: string; listings: number; skipped: { ordinal: number; reason: string }[]; droppedFields: number };

/** Rebuilds JobListing rows from every listing table in the index. Source documents are not touched. */
export async function extractJobListings({ dryRun = false, documentIds }: { dryRun?: boolean; documentIds?: string[] } = {}): Promise<ExtractReport[]> {
  if (!hasLlm()) throw new Error('Job extraction needs the configured LLM');
  const docs = await prisma.document.findMany({
    where: { status: 'INDEXED', accessLevel: 'PUBLIC', ...(documentIds ? { id: { in: documentIds } } : {}) },
    select: { id: true, title: true, url: true, content: true },
  });
  const reports: ExtractReport[] = [];
  for (const d of docs) {
    if (!HEADER.test(d.content.slice(0, 1500))) {
      if (isJobBoardPage(d.url, d.content)) reports.push(await extractWebPostings(d, dryRun));
      continue;
    }
    if (SYNTHETIC.test(d.content.slice(0, 2000))) {
      logger.warn('Skipping a self-declared synthetic listing document', { document: d.title });
      continue;
    }
    const segments = segmentListings(d.content);
    const report: ExtractReport = { document: d.url ?? d.title, listings: 0, skipped: [], droppedFields: 0 };
    const existing = await prisma.jobListing.findMany({ where: { documentId: d.id } });
    const rows: Omit<(typeof existing)[number], 'id' | 'extractedAt'>[] = [];
    for (const seg of segments) {
      // A reasoning model occasionally returns no JSON at all: up to three attempts, then keep the
      // previously verified row if this listing's text has not changed since it was extracted.
      let f = null;
      for (let attempt = 0; attempt < 3 && !f; attempt++) f = await extractFields(seg.text);
      if (!f) {
        const hash = createHash('sha256').update(seg.text).digest('hex');
        const previous = existing.find((e) => e.ordinal === seg.ordinal && e.segmentHash === hash);
        if (previous) {
          const { id: _id, extractedAt: _at, ...kept } = previous;
          rows.push(kept);
        } else report.skipped.push({ ordinal: seg.ordinal, reason: 'extraction returned nothing usable' });
        continue;
      }
      const keep = (v: string | null | undefined) => {
        const x = verbatim(v, seg.text);
        if (v && !x && !/^(not specified|not available)/i.test(v)) report.droppedFields++;
        return x;
      };
      const hash = createHash('sha256').update(seg.text).digest('hex');
      // Same listing text as last time: a field the model dropped this run keeps its earlier verified value
      // (it was checked verbatim against this exact segment), so re-running never loses information.
      const prev = existing.find((e) => e.ordinal === seg.ordinal && e.segmentHash === hash);
      const firstLine = seg.text.split('\n')[0] ?? '';
      // County: the model's value, else the county named on the row's first line (deterministic, verbatim).
      const county = keep(f.county) ?? /\b(?:Placer|El Dorado|Alpine|Sacramento|Nevada|Yolo) County\b|Greater Sacramento Region/.exec(firstLine)?.[0] ?? prev?.county ?? null;
      // The row number is part of the table, not of the title; neither is a county the model ran into.
      let title = keep(f.title)?.replace(new RegExp(`^${seg.ordinal}\\s+`), '') ?? null;
      if (title && county && title.endsWith(` ${county}`)) title = title.slice(0, -county.length - 1).trim();
      if (title && prev && title !== prev.title && title.startsWith(prev.title)) title = prev.title;
      title ??= prev?.title ?? null;
      if (!title) {
        report.skipped.push({ ordinal: seg.ordinal, reason: 'title not found verbatim' });
        continue;
      }
      const pick = <K extends keyof NonNullable<typeof prev>>(k: K, v: string | null) => v ?? ((prev?.[k] as string | null | undefined) ?? null);
      const requiredSkills = pick('requiredSkills', keep(f.requiredSkills));
      const summary = pick('summary', keep(f.summary));
      const occupations = classifyListing(title, `${requiredSkills ?? ''} ${summary ?? ''}`);
      rows.push({
        documentId: d.id, ordinal: seg.ordinal, title,
        employer: pick('employer', keep(f.employer)), county, location: pick('location', keep(f.location)), requiredSkills,
        qualifications: pick('qualifications', keep(f.qualifications)), salary: pick('salary', keep(f.salary)), employmentType: pick('employmentType', keep(f.employmentType)),
        datePosted: pick('datePosted', keep(f.datePosted)), deadline: pick('deadline', keep(f.deadline)), summary,
        sourceUrl: pick('sourceUrl', verbatimUrl(f.sourceUrl, seg.text)), applyUrl: pick('applyUrl', verbatimUrl(f.applyUrl, seg.text)), contact: pick('contact', keep(f.contact)),
        occupations, sector: occupations[0] ? OCCUPATION_BY_KEY.get(occupations[0])!.sector : null,
        segment: seg.text, segmentHash: hash,
      });
    }
    report.listings = rows.length;
    if (!dryRun) {
      await prisma.$transaction([
        prisma.jobListing.deleteMany({ where: { documentId: d.id } }),
        prisma.jobListing.createMany({ data: rows }),
      ]);
    }
    reports.push(report);
  }
  return reports;
}


// ───────────────────────── crawled job-board pages ─────────────────────────

/** A crawled page whose address says it lists vacancies (/jobs, /careers, /job-openings…), not an event or workshop. */
export function isJobBoardPage(url: string | null, content: string): boolean {
  if (!url || /\.pdf(\?|$)/i.test(url)) return false;
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/\/(event|events|news|blog|calendar|workshops?)\//.test(path)) return false;
  return /\/(jobs?|careers?|job-openings|openings|employment|job-board|job-postings|positions|vacancies)(\/|$)/.test(path) && content.length >= 150;
}

const Postings = z.object({
  postings: z.array(z.object({
    title: z.string().nullish(),
    employer: z.string().nullish(),
    location: z.string().nullish(),
    category: z.string().nullish(),
    summary: z.string().nullish(),
    qualifications: z.string().nullish(),
    salary: z.string().nullish(),
    employmentType: z.string().nullish(),
    deadline: z.string().nullish(),
    contact: z.string().nullish(),
  })).max(60),
});

const BOARD_SYSTEM = `You copy job postings out of the text of ONE job-board web page. Return JSON only:
{"postings": [{"title", "employer", "location", "category", "summary", "qualifications", "salary", "employmentType", "deadline", "contact"}]}
Rules:
- Only real job vacancies someone could apply for. Not events, workshops, job fairs, menus, navigation or sign-up forms.
- COPY every value exactly as it appears on the page. Never reword, summarize, translate or correct.
- title: the job title only (e.g. "Director of Finance"), never the employer.
- employer: the hiring organisation exactly as printed, or null.
- summary: the first sentence of the posting's description, exactly, or null.
- Use null for anything the page does not state. If the page lists no vacancies, return {"postings": []}.`;

/** One posting's own text on the page: from its title (or the employer just before it) to the next posting. */
function postingSegments(content: string, titles: { title: string; employer: string | null }[]): (string | null)[] {
  const lower = content.toLowerCase();
  let from = 0;
  const starts = titles.map(({ title, employer }) => {
    const at = lower.indexOf(title.toLowerCase(), from);
    if (at < 0) return -1;
    let start = at;
    if (employer) {
      const e = lower.lastIndexOf(employer.toLowerCase(), at);
      if (e >= from && at - e < 400) start = e;
    }
    from = at + title.length;
    return start;
  });
  return starts.map((start, i) => {
    if (start < 0) return null;
    const next = starts.slice(i + 1).find((x) => x > start) ?? Math.min(content.length, start + 2500);
    return content.slice(start, next).trim();
  });
}

async function extractWebPostings(d: { id: string; title: string; url: string | null; content: string }, dryRun: boolean): Promise<ExtractReport> {
  const report: ExtractReport = { document: d.url ?? d.title, listings: 0, skipped: [], droppedFields: 0 };
  let found: z.infer<typeof Postings>['postings'] | null = null;
  for (let attempt = 0; attempt < 2 && !found; attempt++) {
    const done = await completeAnswer(
      [
        { role: 'system', content: BOARD_SYSTEM },
        { role: 'user', content: d.content.slice(0, 14000) },
      ],
      { label: 'job board extraction', maxTokens: 3000 },
    );
    const parsed = Postings.safeParse(extractJsonObject(done.text));
    if (parsed.success) found = parsed.data.postings;
  }
  if (!found) {
    report.skipped.push({ ordinal: 0, reason: 'extraction returned nothing usable' });
    return report;
  }
  // The title must be on the page; everything else must be inside that posting's own text.
  const titled = found
    .map((p) => ({ p, title: verbatim(p.title, d.content), employer: verbatim(p.employer, d.content) }))
    .filter((x): x is typeof x & { title: string } => {
      if (!x.title) report.skipped.push({ ordinal: 0, reason: `title not found verbatim: ${String(x.p.title).slice(0, 60)}` });
      return Boolean(x.title);
    });
  const segments = postingSegments(d.content, titled.map((x) => ({ title: x.title, employer: x.employer })));
  const rows: Prisma.JobListingCreateManyInput[] = [];
  titled.forEach((x, i) => {
    const seg = segments[i];
    if (!seg) return;
    const keep = (v: string | null | undefined) => {
      const kept = verbatim(v, seg);
      if (v && !kept && !/^(not specified|not available)/i.test(v)) report.droppedFields++;
      return kept;
    };
    const summary = keep(x.p.summary) ?? keep(x.p.category);
    const qualifications = keep(x.p.qualifications);
    const occupations = classifyListing(x.title, `${qualifications ?? ''} ${summary ?? ''} ${x.p.category ?? ''}`);
    const county = /\b(Placer|El Dorado|Alpine|Sacramento|Nevada|Yolo) County\b/.exec(seg)?.[0] ?? null;
    rows.push({
      documentId: d.id, ordinal: rows.length + 1, title: x.title,
      employer: keep(x.p.employer), county, location: keep(x.p.location), requiredSkills: null,
      qualifications, salary: keep(x.p.salary), employmentType: keep(x.p.employmentType),
      datePosted: null, deadline: keep(x.p.deadline), summary,
      // The page itself is the posting's source (document.url); no link is stored that the posting text lacks.
      sourceUrl: null, applyUrl: null, contact: keep(x.p.contact),
      occupations, sector: occupations[0] ? OCCUPATION_BY_KEY.get(occupations[0])!.sector : null,
      segment: seg, segmentHash: createHash('sha256').update(seg).digest('hex'),
    });
  });
  report.listings = rows.length;
  if (!dryRun) {
    await prisma.$transaction([
      prisma.jobListing.deleteMany({ where: { documentId: d.id } }),
      prisma.jobListing.createMany({ data: rows }),
    ]);
  }
  logger.info('Job board extracted', { page: d.url, postings: rows.length, skipped: report.skipped.length, droppedFields: report.droppedFields });
  return report;
}
