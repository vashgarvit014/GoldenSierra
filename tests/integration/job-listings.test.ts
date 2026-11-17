/**
 * Extracted job listings against the live PostgreSQL + Qdrant index (read only).
 * Each listing is one contiguous segment of an indexed, public document; every stored field is verbatim
 * in that segment (no field from a neighbouring listing); its occupations come from the taxonomy; and
 * the chunks a card cites contain the listing and have Qdrant points.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { OCCUPATION_BY_KEY } from '../../src/lib/jobs/occupations';
import { matchJobs } from '../../src/lib/jobs/match';

afterAll(async () => prisma.$disconnect());
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

describe('job listings', () => {
  it('every listing is a segment of an indexed public document, with every field verbatim in its own segment', async () => {
    const rows = await prisma.jobListing.findMany({ include: { document: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.document.status).toBe('INDEXED');
      expect(r.document.accessLevel).toBe('PUBLIC');
      expect(squash(r.document.content)).toContain(squash(r.segment));
      for (const k of ['title', 'employer', 'county', 'location', 'requiredSkills', 'qualifications', 'salary', 'employmentType', 'datePosted', 'deadline', 'summary', 'contact'] as const) {
        if (r[k]) expect(squash(r.segment), `${r.title}.${k}`).toContain(squash(r[k]!));
      }
      for (const u of [r.sourceUrl, r.applyUrl]) if (u) expect(squash(r.segment)).toContain(squash(u));
      for (const o of r.occupations) expect(OCCUPATION_BY_KEY.has(o)).toBe(true);
      // No other listing's segment overlaps this one.
      for (const other of rows) if (other.id !== r.id && other.documentId === r.documentId) expect(squash(r.segment)).not.toContain(squash(other.segment));
    }
  });

  it('synthetic or fictitious documents never produce listings', async () => {
    const rows = await prisma.jobListing.findMany({ include: { document: { select: { content: true } } } });
    for (const r of rows) expect(r.document.content.slice(0, 2000)).not.toMatch(/synthetic|fictitious/i);
  });

  it('matched cards cite chunks that contain the listing and exist in Qdrant', async () => {
    const { matches } = await matchJobs({ mode: 'self', population: [], barriers: [], experience: ['solar_installer'] });
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const chunks = await prisma.documentChunk.findMany({ where: { id: { in: m.source.chunkIds } } });
      expect(chunks.length).toBe(m.source.chunkIds.length);
      for (const c of chunks) expect(squash(c.content)).toContain(squash(m.title));
      const n = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: m.source.chunkIds } }] } });
      expect(n.count).toBe(m.source.chunkIds.length);
    }
  });
});
