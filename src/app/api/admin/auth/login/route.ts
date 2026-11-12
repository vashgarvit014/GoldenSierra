import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { badRequest, unauthorized, withErrorHandling } from '@/lib/errors';
import { clientIpFrom, enforceRateLimit, hashIdentifier } from '@/lib/rate-limit';
import { ADMIN_COOKIE, createAdminToken, recordAudit, verifyPassword } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export const POST = withErrorHandling(async (request: Request) => {
  // Tight limit: this is the brute-force surface.
  await enforceRateLimit(`login:${await hashIdentifier(clientIpFrom(request))}`, 8);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = BodySchema.parse(json);

  const user = await prisma.adminUser.findUnique({
    where: { email: body.email.toLowerCase() },
  });

  // One message for every failure mode, so the endpoint cannot be used to
  // enumerate which email addresses have accounts.
  const invalid = unauthorized('Email or password is incorrect.');
  if (!user || !user.active) {
    // Still spend the hashing time, to keep the response time uniform.
    await verifyPassword(body.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw invalid;
  }

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) throw invalid;

  const token = await createAdminToken({ userId: user.id, email: user.email, role: user.role });

  await prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit(user.id, 'login', 'AdminUser', user.id);

  const response = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });

  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600,
  });

  return response;
});
