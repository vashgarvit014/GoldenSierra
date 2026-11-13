import { NextResponse } from 'next/server';
import { AdminRole } from '@prisma/client';
import { env } from '@/lib/env';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { ingestPdfUpload } from '@/lib/ingest/pipeline';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s is the ceiling on Vercel's Hobby plan, and a route declaring more fails
// the deployment outright. Long-running ingestion does not belong in a
// serverless request anyway — run `npm run ingest` from the CLI or a worker.
export const maxDuration = 60;

/**
 * POST /api/admin/documents/upload — multipart PDF upload.
 *
 * Validation is layered because a file upload is the most direct untrusted
 * input the server accepts: declared size, actual size, extension, declared
 * MIME type, and finally the %PDF magic bytes inside the extractor. Nothing
 * is written to disk — the buffer goes straight to the parser.
 */
export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.EDITOR);

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > env.MAX_UPLOAD_BYTES) {
    throw badRequest(`File exceeds the ${(env.MAX_UPLOAD_BYTES / 1_048_576).toFixed(0)}MB limit`);
  }

  const form = await request.formData().catch(() => {
    throw badRequest('Expected a multipart form upload');
  });

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file was provided');
  if (file.size === 0) throw badRequest('The uploaded file is empty');
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw badRequest(`File exceeds the ${(env.MAX_UPLOAD_BYTES / 1_048_576).toFixed(0)}MB limit`);
  }

  const filename = sanitizeFilename(file.name || 'document.pdf');
  if (!/\.pdf$/i.test(filename)) throw badRequest('Only PDF files can be uploaded');
  if (file.type && file.type !== 'application/pdf') {
    throw badRequest(`Unexpected content type "${file.type}" — only application/pdf is accepted`);
  }

  const readString = (key: string) => {
    const value = form.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const readList = (key: string) =>
    readString(key)?.split(',').map((s) => s.trim()).filter(Boolean);

  const buffer = await file.arrayBuffer();

  try {
    const result = await ingestPdfUpload(buffer, filename, {
      sourceId: readString('sourceId') ?? null,
      url: readString('url') ?? null,
      overrides: {
        category: readString('category'),
        audience: readString('audience'),
        programName: readString('programName'),
        counties: readList('counties'),
        tags: readList('tags'),
        accessLevel: readString('accessLevel') === 'INTERNAL' ? 'INTERNAL' : 'PUBLIC',
      },
    });

    await recordAudit(session.userId, 'upload_pdf', 'Document', result.documentId, {
      filename,
      bytes: file.size,
      action: result.action,
    });

    return NextResponse.json(
      {
        documentId: result.documentId,
        action: result.action,
        chunksIndexed: result.chunks,
        reason: result.reason,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('PDF upload failed', { filename, error: message });
    // Extraction failures are the uploader's problem to fix, so report them.
    throw badRequest(`Could not process this PDF: ${message}`);
  }
});

/** Strips path separators so a crafted filename cannot escape into a path. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/[^\w.\- ]/g, '').slice(0, 200);
}
