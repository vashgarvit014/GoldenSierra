/**
 * Creates or updates an admin user.
 *
 * Interactive:
 *   npm run admin:create
 *   npm run admin:create -- --email=you@example.com --role=EDITOR
 *
 * Non-interactive (deployment / CI) — the password comes from the environment
 * so it never lands in shell history or a process listing:
 *   ADMIN_PASSWORD='…' npm run admin:create -- --email=you@example.com --role=ADMIN
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { AdminRole } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

async function main() {
  const roleInput = (arg('role') ?? 'ADMIN').toUpperCase();
  if (!(roleInput in AdminRole)) {
    throw new Error(`Role must be one of: ${Object.keys(AdminRole).join(', ')}`);
  }

  let email = arg('email')?.trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD;

  // Only open a prompt for what was not supplied. A fully-specified
  // invocation must never block waiting on stdin, or an automated deploy hangs.
  if (!email || !password) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Missing --email or ADMIN_PASSWORD, and stdin is not a terminal.\n' +
          "Run: ADMIN_PASSWORD='…' npm run admin:create -- --email=you@example.com --role=ADMIN",
      );
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      email ??= (await rl.question('Email: ')).trim().toLowerCase();
      if (!password) {
        password = (await rl.question('Password (min 10 characters): ')).trim();
        const confirm = (await rl.question('Confirm password: ')).trim();
        if (password !== confirm) throw new Error('Passwords do not match');
      }
    } finally {
      rl.close();
    }
  }

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('A valid email address is required');
  }
  if (!password || password.length < 10) {
    throw new Error('Password must be at least 10 characters');
  }

  const passwordHash = await hashPassword(password);
  const name = arg('name') ?? null;

  const user = await prisma.adminUser.upsert({
    where: { email },
    create: { email, name, passwordHash, role: roleInput as AdminRole },
    update: { passwordHash, role: roleInput as AdminRole, active: true },
  });

  console.log(`\nAdmin ready: ${user.email} (${user.role})`);
  console.log('Sign in at /admin');
}

main()
  .catch((err) => {
    console.error('\nFailed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
