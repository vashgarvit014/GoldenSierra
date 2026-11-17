/**
 * Guided-conversation retrieval against the real PostgreSQL + Qdrant index (read only; nothing is
 * written). Every passage the guided flow would hand to the generator must be an indexed, public
 * chunk whose text and vector are what PostgreSQL records — and a focus that requires a place must
 * only use passages that mention it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { prepareGuidedResults } from '../../src/lib/conversation/evidence';
import { namedIn } from '../../src/lib/programs/link';
import type { CounselorContext } from '../../src/types/counselor';

const FOSTER: CounselorContext = {
  mode: 'helper', age: 19, ageBand: '18_24', population: ['youth', 'former_foster_youth'], careerInterest: 'healthcare',
  education: 'no_hs_diploma', city: 'auburn', county: 'Placer', transportation: 'none', incomeUrgency: 'immediate', barriers: [],
};

afterAll(async () => prisma.$disconnect());

describe('guided retrieval over the live index', () => {
  it('uses only validated, indexed, public chunks that exist in Qdrant, at most six', async () => {
    const { prepared, focusOf } = await prepareGuidedResults(FOSTER, 'She needs income urgently.');
    const used = prepared.usedSources;
    expect(used.length).toBeGreaterThan(0);
    expect(used.length).toBeLessThanOrEqual(6);

    const rows = await prisma.documentChunk.findMany({ where: { id: { in: used.map((u) => u.chunkId) } }, include: { document: true } });
    expect(rows).toHaveLength(used.length);
    for (const u of used) {
      const row = rows.find((r) => r.id === u.chunkId)!;
      expect(row.documentId).toBe(u.documentId);
      expect(row.document.status).toBe('INDEXED');
      expect(row.document.accessLevel).toBe('PUBLIC');
      expect(u.url).toBe(row.document.url);
      expect(focusOf.get(u.chunkId)).toBeDefined();
    }
    const points = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: used.map((u) => u.chunkId) } }] } });
    expect(points.count).toBe(used.length);
    // The prompt cites by these numbers, so every used chunk is in the SOURCES block.
    const prompt = prepared.messages.at(-1)!.content;
    used.forEach((_, i) => expect(prompt).toContain(`<source id="${i + 1}"`));
  });

  it('a location focus only keeps passages that name the place', async () => {
    const { prepared, focusOf } = await prepareGuidedResults(FOSTER, 'x');
    for (const u of prepared.usedSources.filter((s) => focusOf.get(s.chunkId)?.key === 'location')) {
      expect(`${u.title} ${u.headingPath ?? ''} ${u.snippet}`.toLowerCase()).toContain('auburn');
    }
  });

  it('a need nothing in the index covers produces no evidence rather than a near miss', async () => {
    const { prepared } = await prepareGuidedResults({ mode: 'self', population: [], barriers: [], careerInterest: 'deep sea saturation diving' }, 'x');
    const careerChunks = prepared.usedSources.filter((s) => /saturation|diving/i.test(s.snippet));
    expect(careerChunks).toEqual([]);
  });

  it('a GED need is not answered with a job posting that merely requires a diploma', async () => {
    const { prepared, focusOf } = await prepareGuidedResults({ mode: 'self', population: [], barriers: [], education: 'no_hs_diploma' }, 'x');
    for (const u of prepared.usedSources.filter((s) => focusOf.get(s.chunkId)?.key === 'education')) {
      expect(`${u.title} ${u.snippet}`).toMatch(/\b(ged|hiset|equivalency|adult (school|education))\b/i);
    }
  });
});

describe('program ↔ document links', () => {
  it('every link joins an active program to an indexed, public document on its own host whose text names it', async () => {
    const links = await prisma.programDocument.findMany({
      include: { program: true, document: { include: { chunks: { select: { content: true, headingPath: true } } } } },
    });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.document.status).toBe('INDEXED');
      expect(l.document.accessLevel).toBe('PUBLIC');
      expect(new URL(l.document.url!).hostname).toBe(new URL(l.program.officialUrl!).hostname);
      expect(l.document.chunks.some((c) => namedIn(`${c.headingPath ?? ''} ${c.content}`, l.program))).toBe(true);
      expect(l.document.title + l.document.url).not.toMatch(/agenda|packet|minutes|sitemap/i);
    }
  });
});

