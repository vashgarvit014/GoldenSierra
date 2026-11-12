import { describe, expect, it } from 'vitest';
import { chunkDocument, recommendedChunking } from '@/lib/ingest/chunk';

/**
 * Chunking tests focus on one property above all: an eligibility statement
 * must stay attached to the heading that scopes it. A rule that drifts into a
 * neighbouring program's chunk is how a retrieval system ends up confidently
 * telling someone the wrong requirements.
 */

const PAGE = `# Help for Job Seekers

You're in the right place.

## Apply for a Scholarship

Quality jobs tend to require specialized skills and credentials. We offer tuition assistance and other financial aid.

## Get a Paid Internship

Explore potential career pathways, build your resume, and get paid to learn new skills. Open to young adults ages 16 to 24.

## Who We Help

We serve individuals in Placer, El Dorado, and Alpine counties. Veterans and eligible spouses receive priority of service.`;

describe('chunkDocument', () => {
  it('keeps each eligibility statement under its own heading', async () => {
    const chunks = await chunkDocument(PAGE, { documentTitle: 'Help for Job Seekers' });

    const internship = chunks.find((c) => c.content.includes('ages 16 to 24'));
    expect(internship).toBeDefined();
    expect(internship!.headingPath).toContain('Paid Internship');
    // The age range must not leak into the scholarship section.
    expect(internship!.content).not.toContain('tuition assistance');

    const veterans = chunks.find((c) => c.content.includes('priority of service'));
    expect(veterans!.headingPath).toContain('Who We Help');
  });

  it('prefixes chunks with their heading trail so the embedding carries context', async () => {
    const chunks = await chunkDocument(PAGE, { documentTitle: 'Help for Job Seekers' });
    const scholarship = chunks.find((c) => c.content.includes('tuition assistance'));

    expect(scholarship!.content).toContain('Apply for a Scholarship');
  });

  it('does not repeat a heading segment that matches the document title', async () => {
    const chunks = await chunkDocument(PAGE, { documentTitle: 'Help for Job Seekers' });

    for (const chunk of chunks) {
      const occurrences = chunk.content.split('Help for Job Seekers').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('splits a section that exceeds the chunk size', async () => {
    const long = `# Long Section\n\n${'This sentence describes a workforce service in detail. '.repeat(90)}`;
    const chunks = await chunkDocument(long, { chunkSize: 500, chunkOverlap: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.headingPath).toContain('Long Section');
  });

  it('assigns sequential ordinals and a hash to every chunk', async () => {
    const chunks = await chunkDocument(PAGE, { documentTitle: 'Help for Job Seekers' });

    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it('handles text with no headings at all', async () => {
    const chunks = await chunkDocument('Just a paragraph of plain text about workforce services.');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBeNull();
  });

  it('returns nothing for empty input rather than an empty chunk', async () => {
    expect(await chunkDocument('   \n\n  ')).toHaveLength(0);
  });

  it('does not merge small sections that belong to different top-level headings', async () => {
    const page = `# Program A\n\nShort text A.\n\n# Program B\n\nShort text B.`;
    const chunks = await chunkDocument(page);

    const merged = chunks.find((c) => c.content.includes('Short text A') && c.content.includes('Short text B'));
    expect(merged).toBeUndefined();
  });
});

describe('recommendedChunking', () => {
  it('recommends larger chunks for long-context embedding models', () => {
    const bge = recommendedChunking('BAAI/bge-m3');
    const small = recommendedChunking('text-embedding-3-small');

    expect(bge.chunkSize).toBeGreaterThan(small.chunkSize);
    expect(bge.rationale).toBeTruthy();
  });

  it('falls back to configured defaults for an unknown model', () => {
    expect(recommendedChunking('some-new-model').rationale).toMatch(/unrecognised/i);
  });
});
