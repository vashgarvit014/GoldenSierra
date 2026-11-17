import { createHash } from 'node:crypto';
import { z } from 'zod';
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
export async function extractJobListings({ dryRun = false } = {}): Promise<ExtractReport[]> {
  if (!hasLlm()) throw new Error('Job extraction needs the configured LLM');
  const docs = await prisma.document.findMany({ where: { status: 'INDEXED', accessLevel: 'PUBLIC' }, select: { id: true, title: true, url: true, content: true } });
  const reports: ExtractReport[] = [];
  for (const d of docs) {
    if (!HEADER.test(d.content.slice(0, 1500))) continue;
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
      // The row number is part of the table, not of the title.
      const title = keep(f.title)?.replace(new RegExp(`^${seg.ordinal}\\s+`), '') ?? null;
      if (!title) {
        report.skipped.push({ ordinal: seg.ordinal, reason: 'title not found verbatim' });
        continue;
      }
      const requiredSkills = keep(f.requiredSkills);
      const summary = keep(f.summary);
      const occupations = classifyListing(title, `${requiredSkills ?? ''} ${summary ?? ''}`);
      rows.push({
        documentId: d.id, ordinal: seg.ordinal, title,
        employer: keep(f.employer), county: keep(f.county), location: keep(f.location), requiredSkills,
        qualifications: keep(f.qualifications), salary: keep(f.salary), employmentType: keep(f.employmentType),
        datePosted: keep(f.datePosted), deadline: keep(f.deadline), summary,
        sourceUrl: verbatimUrl(f.sourceUrl, seg.text), applyUrl: verbatimUrl(f.applyUrl, seg.text), contact: keep(f.contact),
        occupations, sector: occupations[0] ? OCCUPATION_BY_KEY.get(occupations[0])!.sector : null,
        segment: seg.text, segmentHash: createHash('sha256').update(seg.text).digest('hex'),
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
