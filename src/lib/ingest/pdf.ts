import { extractText, getDocumentProxy } from 'unpdf';
import { env } from '../env';
import { normalizeText } from './extract';
import { withTimeout } from '../errors';
import { logger } from '../logger';

/**
 * PDF text extraction. `unpdf` wraps a serverless build of pdf.js, so this
 * runs in the Node runtime without a native dependency — the practical
 * equivalent of PyMuPDF for a TypeScript codebase.
 */

export type ExtractedPdf = {
  url: string | null;
  title: string;
  text: string;
  pageCount: number;
  byteSize: number;
  publishedAt: Date | null;
};

export async function extractPdfFromBuffer(
  buffer: ArrayBuffer | Uint8Array,
  opts: { url?: string | null; filename?: string } = {},
): Promise<ExtractedPdf> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.byteLength > env.MAX_UPLOAD_BYTES) {
    throw new Error(
      `PDF is ${(bytes.byteLength / 1_048_576).toFixed(1)}MB, above the ${(
        env.MAX_UPLOAD_BYTES / 1_048_576
      ).toFixed(0)}MB limit`,
    );
  }
  if (!looksLikePdf(bytes)) {
    throw new Error('File is not a valid PDF (missing %PDF header)');
  }

  const pdf = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const raw = Array.isArray(text) ? text.join('\n\n') : text;

  let title = opts.filename?.replace(/\.pdf$/i, '') ?? '';
  let publishedAt: Date | null = null;
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as { Title?: string; CreationDate?: string } | undefined;
    if (info?.Title?.trim()) title = info.Title.trim();
    if (info?.CreationDate) publishedAt = parsePdfDate(info.CreationDate);
  } catch {
    // Metadata is optional; the extracted text is what matters.
  }

  if (!title && opts.url) {
    title = decodeURIComponent(opts.url.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  }

  const cleaned = cleanPdfText(raw);
  if (cleaned.length < 40) {
    throw new Error(
      'PDF produced almost no text. It is probably a scanned image and needs OCR before indexing.',
    );
  }

  return {
    url: opts.url ?? null,
    title: title || 'Untitled document',
    text: cleaned,
    pageCount: totalPages,
    byteSize: bytes.byteLength,
    publishedAt,
  };
}

export async function fetchAndExtractPdf(url: string): Promise<ExtractedPdf> {
  const response = await withTimeout(
    fetch(url, { headers: { 'User-Agent': env.CRAWL_USER_AGENT } }),
    env.CRAWL_TIMEOUT_MS,
    `fetch pdf ${url}`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > env.MAX_UPLOAD_BYTES) {
    throw new Error(`PDF at ${url} exceeds the configured size limit`);
  }

  const buffer = await response.arrayBuffer();
  logger.debug('Fetched PDF', { url, bytes: buffer.byteLength });
  return extractPdfFromBuffer(buffer, { url });
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF" — checked on upload so a renamed executable can't reach the parser.
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Removes the artefacts that make PDF text hostile to chunking: hyphenated
 * line breaks, page-number lines, and hard wraps mid-sentence.
 */
function cleanPdfText(raw: string): string {
  return normalizeText(
    raw
      .replace(/-\n(?=[a-z])/g, '') // re-join hyphen-split words
      .replace(/\n(?=[a-z,;])/g, ' ') // unwrap mid-sentence breaks
      .replace(/^\s*(page\s*)?\d+\s*(of\s*\d+)?\s*$/gim, '') // page numbers
      .replace(/\f/g, '\n\n'), // form feed -> paragraph break
  );
}

function parsePdfDate(value: string): Date | null {
  // PDF date syntax: D:YYYYMMDDHHmmSS+HH'mm'
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
