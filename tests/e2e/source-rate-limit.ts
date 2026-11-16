/**
 * Per-administrator source-registration rate limit, over real HTTP.
 * Start the dev server with SOURCE_ADD_RATE_PER_HOUR=5 and run with E2E_SOURCE_LIMIT=5.
 * Uses a throwaway EDITOR account (own bucket) and only submits URLs that are refused,
 * so no source is ever created. The account is removed afterwards.
 */
import 'dotenv/config';
import { hashPassword } from '../../src/lib/auth';
import { prisma } from '../../src/lib/db';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const LIMIT = Number(process.env.E2E_SOURCE_LIMIT ?? 5);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `  → ${d}`}`); };

(async () => {
  const email = `ratelimit-${Date.now()}@test.invalid`;
  const user = await prisma.adminUser.create({ data: { email, passwordHash: await hashPassword('RateLimitPassw0rd!'), role: 'EDITOR' } });
  try {
    const login = await fetch(`${BASE}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'RateLimitPassw0rd!' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const before = await prisma.knowledgeSource.count();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 3; i++) {
      const r = await fetch(`${BASE}/api/admin/sources`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: `rl-${i}`, type: 'WEBSITE', rootUrl: 'https://127.0.0.1/', startCrawl: false }) });
      statuses.push(r.status);
    }
    check(`first ${LIMIT} attempts are processed (refused as private: 400)`, statuses.slice(0, LIMIT).every((s) => s === 400), statuses.join(','));
    check('attempts beyond the limit are throttled (429)', statuses.slice(LIMIT).every((s) => s === 429), statuses.join(','));
    check('probing a refused URL still counts against the limit (no free scanning)', statuses[LIMIT] === 429);
    check('no source was created by any attempt', (await prisma.knowledgeSource.count()) === before);
  } finally {
    await prisma.adminUser.delete({ where: { id: user.id } });
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
