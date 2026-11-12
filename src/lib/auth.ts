import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { AdminRole } from '@prisma/client';
import { env, requireAuthSecret } from './env';
import { prisma } from './db';
import { forbidden, unauthorized } from './errors';
import { logger } from './logger';

/**
 * Admin authentication (JWT in an httpOnly cookie) and role-based access.
 *
 * Chat users are never authenticated — the assistant is public and anonymous
 * by design. Only the knowledge-management dashboard is gated.
 */

export const ADMIN_COOKIE = 'gs_admin';

export type AdminSession = { userId: string; email: string; role: AdminRole };

const ROLE_RANK: Record<AdminRole, number> = {
  [AdminRole.VIEWER]: 1,
  [AdminRole.EDITOR]: 2,
  [AdminRole.ADMIN]: 3,
};

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createAdminToken(session: AdminSession): Promise<string> {
  return new SignJWT({ email: session.email, role: session.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_HOURS}h`)
    .sign(requireAuthSecret());
}

export async function readAdminToken(token: string): Promise<AdminSession | null> {
  try {
    const { payload } = await jwtVerify(token, requireAuthSecret());
    if (!payload.sub || typeof payload.email !== 'string' || typeof payload.role !== 'string') {
      return null;
    }
    if (!(payload.role in ROLE_RANK)) return null;
    return { userId: payload.sub, email: payload.email, role: payload.role as AdminRole };
  } catch {
    return null;
  }
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!token) return null;

  const session = await readAdminToken(token);
  if (!session) return null;

  // A deactivated account must lose access immediately, not at token expiry.
  const user = await prisma.adminUser.findUnique({
    where: { id: session.userId },
    select: { active: true, role: true },
  });
  if (!user?.active) return null;

  // Trust the database for the current role, not the token's snapshot.
  return { ...session, role: user.role };
}

export async function requireAdmin(minimum: AdminRole = AdminRole.VIEWER): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) throw unauthorized('Please sign in to the admin dashboard.');
  if (ROLE_RANK[session.role] < ROLE_RANK[minimum]) {
    throw forbidden(`This action requires the ${minimum.toLowerCase()} role.`);
  }
  return session;
}

export async function recordAudit(
  actorId: string | null,
  action: string,
  entity: string,
  entityId?: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        actorId,
        action,
        entity,
        entityId: entityId ?? null,
        metadata: (metadata ?? {}) as never,
      },
    })
    .catch((err) => logger.warn('Could not write audit entry', { action, error: String(err) }));
}
