import { NextResponse } from 'next/server';
import { ADMIN_COOKIE, getAdminSession, recordAudit } from '@/lib/auth';
import { withErrorHandling } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async () => {
  const session = await getAdminSession();
  if (session) await recordAudit(session.userId, 'logout', 'AdminUser', session.userId);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return response;
});
