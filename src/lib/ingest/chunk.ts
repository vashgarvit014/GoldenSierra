import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { env } from '../env';
import { contentHash } from './clean';
import { estimateTokens } from '../ai/embeddings';

/**
 * Heading-aware semantic chunking.
 *
 * Plain fixed-window splitting is the usual cause of wrong eligibility answers:
 * it severs "You may qualify if..." from the program heading it belongs to, and
 * the orphaned rule then gets retrieved against the wrong program. So we split
 * on the heading hierarchy first, and only fall back to character splitting
 * inside a section that is genuinely too long for one chunk.
 *
 * Every chunk carries its heading trail, which is prepended to the embedded
 * text so the vector reflects the section's subject as well as its words.
 */

export type Chunk = {
  ordinal: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
  contentHash: string;
};

export type ChunkOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  /** Prepended to every chunk's embedded text (normally the document title). */
  documentTitle?: string;
};

type Section = { headingPath: string[]; lines: string[] };

/**
 * Section headings that mark cross-page widgets rather than page content.
 *
 * A WordPress events theme repeats a "Related Events" list on every event
 * page, so one widget becomes a dozen near-identical chunks that mention many
 * topics and answer none — they outranked the actual service pages before
 * this filter existed. Dropping them at the section level is more robust than
 * CSS selectors, which change with the theme.
 */
const BOILERPLATE_HEADINGS =
  /^(related|more|other|upcoming|recent|similar|you might|you may)\s+(events?|posts?|articles?|stories|like)|^(share|follow|subscribe|newsletter|categories|tags|archives?|navigation|breadcrumb|search results?)\b/i;

function isBoilerplateSection(headingPath: string[]): boolean {
  // Any segment, not just the deepest: these widgets nest their own headings
  // ("Job One: Networking > Related Events > Career Pathways"), so testing
  // only the last segment misses the entire subtree beneath the widget.
  return headingPath.some((segment) => BOILERPLATE_HEADINGS.test(segment.trim()));
}

/** Parses "## Heading" markers produced by the extractor into a section tree. */
function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { headingPath: [], lines: [] };

  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (!heading) {
      current.lines.push(line);
      continue;
    }

    if (current.lines.some((l) => l.trim())) sections.push(current);

    const level = heading[1]!.length;
    const title = heading[2]!.trim();

    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title });

    current = { headingPath: stack.map((s) => s.title), lines: [] };
  }

  if (current.lines.some((l) => l.trim())) sections.push(current);
  return sections.length ? sections : [{ headingPath: [], lines: text.split('\n') }];
}

export async function chunkDocument(text: string, options: ChunkOptions = {}): Promise<Chunk[]> {
  const chunkSize = options.chunkSize ?? env.CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? env.CHUNK_OVERLAP;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    // Paragraph -> line -> sentence -> word. Sentence-level separators keep a
    // split from landing in the middle of a requirement.
    separators: ['\n\n', '\n', '. ', '; ', ', ', ' ', ''],
  });

  const sections = splitIntoSections(text);
  const chunks: Chunk[] = [];
  let ordinal = 0;

  // Sections smaller than this are merged with the next one rather than being
  // embedded alone, where they would carry too little signal to rank well.
  const MIN_SECTION_CHARS = Math.floor(chunkSize * 0.35);
  let pending: { headingPath: string[]; body: string } | null = null;

  const flush = async (headingPath: string[], body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;

    const heading = headingPath.join(' > ') || null;
    const pieces =
      trimmed.length <= chunkSize ? [trimmed] : await splitter.splitText(trimmed);

    for (const piece of pieces) {
      const content = piece.trim();
      if (!content) continue;
      // Prefixing the heading trail means the embedding encodes both the
      // section subject and the sentence, which is what makes
      // "scholarship eligibility" match text that never repeats the word.
      const embedded = buildEmbeddableText(content, heading, options.documentTitle);
      chunks.push({
        ordinal: ordinal++,
        content: embedded,
        headingPath: heading,
        tokenCount: estimateTokens(embedded),
        contentHash: contentHash(embedded),
      });
    }
  };

  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;
    // A widget repeated across pages is navigation, not an answer.
    if (isBoilerplateSection(section.headingPath)) continue;

    if (pending) {
      const merged = `${pending.body}\n\n${body}`.trim();
      // Merging is only safe when one section is an ancestor of the other —
      // intro prose flowing into its first subsection. Sibling sections must
      // never merge: on a typical service page every section shares the page
      // <h1>, so a "same top-level heading" test would collapse every program
      // on the page into a single chunk and carry each one's eligibility rules
      // into the others.
      if (merged.length < MIN_SECTION_CHARS * 2 && isAncestorOrSame(pending.headingPath, section.headingPath)) {
        pending = {
          // Keep the more specific path, so the chunk is still labelled with
          // the section it mostly describes.
          headingPath:
            section.headingPath.length >= pending.headingPath.length
              ? section.headingPath
              : pending.headingPath,
          body: merged,
        };
        continue;
      }
      await flush(pending.headingPath, pending.body);
      pending = null;
    }

    if (body.length < MIN_SECTION_CHARS) {
      pending = { headingPath: section.headingPath, body };
      continue;
    }

    await flush(section.headingPath, body);
  }

  if (pending) await flush(pending.headingPath, pending.body);

  return chunks;
}

function buildEmbeddableText(content: string, heading: string | null, title?: string): string {
  // A page's <h1> is usually identical to its <title>, so a naive join yields
  // "Help for Job Seekers > Help for Job Seekers > Who we help". Collapse
  // repeated segments — the duplication wastes tokens and skews the embedding
  // toward the title rather than the section.
  const segments: string[] = [];
  for (const part of [...(title ? [title] : []), ...(heading ? heading.split(' > ') : [])]) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (segments.some((s) => s.toLowerCase() === trimmed.toLowerCase())) continue;
    segments.push(trimmed);
  }

  const prefix = segments.join(' > ');
  if (!prefix || content.startsWith(prefix)) return content;
  return `${prefix}\n\n${content}`;
}

/**
 * True when one heading path is the same as, or a direct ancestor of, the
 * other — the only relationship under which two sections may be combined.
 */
function isAncestorOrSame(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0) return true; // untitled lead-in prose
  return shorter.every((segment, i) => segment === longer[i]);
}

/**
 * Recommended chunk size for a given embedding model. Called by the setup
 * check so the defaults are justified by the model in use rather than picked
 * arbitrarily — short-context models lose recall on long chunks, while BGE-M3
 * handles much longer passages well.
 */
export function recommendedChunking(model: string): { chunkSize: number; chunkOverlap: number; rationale: string } {
  if (/bge-m3/i.test(model)) {
    return {
      chunkSize: 1400,
      chunkOverlap: 200,
      rationale: 'BGE-M3 supports an 8k context; larger chunks keep whole program sections together.',
    };
  }
  if (/text-embedding-3-large/i.test(model)) {
    return {
      chunkSize: 1100,
      chunkOverlap: 180,
      rationale: 'text-embedding-3-large retains detail well at ~275 tokens per chunk.',
    };
  }
  if (/text-embedding-3-small|text-embedding-ada/i.test(model)) {
    return {
      chunkSize: 900,
      chunkOverlap: 150,
      rationale:
        'Smaller models dilute with long inputs; ~225 tokens per chunk keeps one idea per vector.',
    };
  }
  return {
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
    rationale: 'Unrecognised embedding model — using the configured defaults. Validate with an eval run.',
  };
}
