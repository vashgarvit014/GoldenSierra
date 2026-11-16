/**
 * Real HTTP tests of the admin ingestion + upload APIs against a running dev server.
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/ingest-http.ts
 * Synthetic data only; everything created is removed at the end (by id).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { AdminRole } from '@prisma/client';
import { prisma } from '../../src/lib/db';
import { createAdminToken } from '../../src/lib/auth';
import { deleteByDocument, getQdrant } from '../../src/lib/vector/qdrant';
import { env } from '../../src/lib/env';
import { syntheticLines, syntheticPdf } from '../helpers/synthetic-pdf';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const RUN = randomUUID().slice(0, 8);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
}

type Res = { status: number; body: any };
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const { cookie, ...rest } = init;
  const res = await fetch(BASE + path, { ...rest, headers: { ...(rest.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}
const postJson = (path: string, json: unknown, cookie?: string) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json), cookie });

function upload(bytes: ArrayBuffer | string, filename: string, type: string, cookie: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', new File([bytes], filename, { type }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return call('/api/admin/documents/upload', { method: 'POST', body: form, cookie });
}

const jobIds = new Set<string>();
const documentIds = new Set<string>();

async function pollJob(id: string, cookie: string, want: string, ms = 30000) {
  const t = Date.now();
  let job: any;
  while (Date.now() - t < ms) {
    job = (await call(`/api/admin/ingestion/status?jobId=${id}`, { cookie })).body?.job;
    if (job?.status === want) return job;
    await new Promise((r) => setTimeout(r, 700));
  }
  return job;
}

(async () => {
  const jobsAtStart = await prisma.ingestionJob.count();
  const docsAtStart = await prisma.document.count();
  const sourcesAtStart = await prisma.knowledgeSource.count();

  // ── authentication & authorization ──
  check('POST /ingestion without a session → 401', (await postJson('/api/admin/ingestion', { type: 'PDF_INGEST', url: 'https://x.invalid/a.pdf' })).status === 401);
  check('POST /documents/upload without a session → 401', (await upload(syntheticPdf(syntheticLines('x')), 'a.pdf', 'application/pdf', '')).status === 401);
  check('GET /ingestion/status without a session → 401', (await call('/api/admin/ingestion/status')).status === 401);

  const login = await fetch(BASE + '/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  check('admin login → 200 + session cookie', login.status === 200 && cookie.startsWith('gs_admin='), `status ${login.status}`);

  // The server trusts the DB for role and active state, so the viewer must really exist (removed at the end).
  const viewerUser = await prisma.adminUser.create({
    data: { email: `viewer-${RUN}@test.invalid`, passwordHash: 'x-not-a-real-hash', role: AdminRole.VIEWER },
  });
  const viewer = `gs_admin=${await createAdminToken({ userId: viewerUser.id, email: viewerUser.email, role: AdminRole.VIEWER })}`;
  check('VIEWER cannot start ingestion → 403', (await postJson('/api/admin/ingestion', { type: 'PDF_INGEST', url: 'https://x.invalid/a.pdf' }, viewer)).status === 403);
  check('VIEWER cannot upload → 403', (await upload(syntheticPdf(syntheticLines('x')), 'a.pdf', 'application/pdf', viewer)).status === 403);
  check('VIEWER can read status → 200', (await call('/api/admin/ingestion/status', { cookie: viewer })).status === 200);

  // ── URL validation + SSRF through the API ──
  const bad: Array<[string, unknown]> = [
    ['upload:// scheme', 'upload://Scrapedata.pdf'],
    ['ftp scheme', 'ftp://host.example/a.pdf'],
    ['file scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:application/pdf;base64,AAAA'],
    ['not a url', 'definitely not a url'],
    ['embedded credentials', 'https://user:secret@host.example/a.pdf'],
    ['localhost', 'http://localhost:3100/a.pdf'],
    ['loopback IP', 'http://127.0.0.1/a.pdf'],
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['private 10/8', 'http://10.0.0.8/a.pdf'],
    ['private 192.168/16', 'http://192.168.1.1/a.pdf'],
    ['IPv6 loopback', 'http://[::1]/a.pdf'],
    ['internal hostname', 'http://db.internal/a.pdf'],
    ['too long', 'https://host.example/' + 'a'.repeat(2100)],
    ['missing', undefined],
    ['wrong type', 12345],
  ];
  const before = await prisma.ingestionJob.count();
  for (const [label, url] of bad) {
    const r = await postJson('/api/admin/ingestion', { type: 'PDF_INGEST', url }, cookie);
    check(`reject PDF_INGEST url: ${label} → 400`, r.status === 400, `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  check('rejected requests created no job rows', (await prisma.ingestionJob.count()) === before);
  const leak = await postJson('/api/admin/ingestion', { type: 'PDF_INGEST', url: 'https://user:topsecret@host.example/a.pdf' }, cookie);
  check('error body does not echo credentials', !JSON.stringify(leak.body).includes('topsecret'));

  // ── authorized invalid test URL → queued → worker → FAILED with cause ──
  const q = await postJson('/api/admin/ingestion', { type: 'PDF_INGEST', url: `https://pdf-http-${RUN}.invalid/x.pdf` }, cookie);
  check('valid-but-unreachable URL accepted → 202', q.status === 202 && !!q.body.jobId, JSON.stringify(q.body));
  if (q.body.jobId) {
    jobIds.add(q.body.jobId);
    const job = await pollJob(q.body.jobId, cookie, 'FAILED', 40000);
    check('worker marks it FAILED', job?.status === 'FAILED', JSON.stringify(job?.status));
    check('FAILED row carries the cause (…ENOTFOUND)', /ENOTFOUND|EAI_AGAIN/.test(job?.error ?? ''), String(job?.error));
  }

  // ── upload API ──
  const pdf = syntheticPdf(syntheticLines(`${RUN}-http`));
  const name = `http-${RUN}.pdf`;
  const up = await upload(pdf.slice(0), name, 'application/pdf', cookie);
  check('upload synthetic PDF → 201 with documentId + jobId', up.status === 201 && !!up.body.documentId && !!up.body.jobId, JSON.stringify(up.body));
  if (up.body.documentId) {
    documentIds.add(up.body.documentId);
    jobIds.add(up.body.jobId);
    const job = (await call(`/api/admin/ingestion/status?jobId=${up.body.jobId}`, { cookie })).body.job;
    check('upload recorded as a COMPLETED PDF_INGEST job', job?.status === 'COMPLETED' && job?.type === 'PDF_INGEST', JSON.stringify(job));
    check('job counters: 1 created, chunks match response', job?.documentsCreated === 1 && job?.chunksIndexed === up.body.chunksIndexed, JSON.stringify(job));
    const rows = await prisma.documentChunk.findMany({ where: { documentId: up.body.documentId } });
    const pts = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { value: up.body.documentId } }] } });
    check('Postgres chunks == Qdrant points for the upload', rows.length > 0 && rows.length === pts.count && rows.every((r) => r.vectorId), `${rows.length} vs ${pts.count}`);

    const again = await upload(pdf.slice(0), name, 'application/pdf', cookie);
    if (again.body.jobId) jobIds.add(again.body.jobId);
    const rows2 = await prisma.documentChunk.count({ where: { documentId: up.body.documentId } });
    check('re-upload is a no-op (unchanged, no duplicate chunks)', again.status === 201 && again.body.action === 'unchanged' && rows2 === rows.length, JSON.stringify(again.body));
  }

  const fake = await upload('this is not a pdf', `fake-${RUN}.pdf`, 'application/pdf', cookie);
  check('non-PDF bytes named .pdf → 400', fake.status === 400, `status ${fake.status}`);
  const failedUpload = await prisma.ingestionJob.findFirst({ where: { params: { path: ['filename'], equals: `fake-${RUN}.pdf` } } });
  if (failedUpload) jobIds.add(failedUpload.id);
  check('…and is recorded as a FAILED job with a reason', failedUpload?.status === 'FAILED' && /not a valid PDF/.test(failedUpload.error ?? ''), JSON.stringify(failedUpload?.status));
  check('wrong extension → 400', (await upload(syntheticPdf(syntheticLines('x')), 'a.txt', 'application/pdf', cookie)).status === 400);
  check('wrong MIME type → 400', (await upload(syntheticPdf(syntheticLines('x')), 'a.pdf', 'text/plain', cookie)).status === 400);
  check('empty file → 400', (await upload('', 'empty.pdf', 'application/pdf', cookie)).status === 400);
  for (const url of ['upload://x.pdf', 'http://localhost/a.pdf', 'http://169.254.169.254/a.pdf', 'ftp://h/a.pdf']) {
    check(`upload with bad public url ${url} → 400`, (await upload(syntheticPdf(syntheticLines('x')), `u-${RUN}.pdf`, 'application/pdf', cookie, { url })).status === 400);
  }
  check('path traversal filename is sanitised, not rejected as a path', (await upload(syntheticPdf(syntheticLines(`${RUN}-trav`)), `../../etc/${RUN}-trav.pdf`, 'application/pdf', cookie)).status === 201);
  for (const d of await prisma.document.findMany({ where: { url: { contains: `${RUN}-trav` } }, select: { id: true, url: true } })) {
    documentIds.add(d.id);
    check('stored under a sanitised internal id (no path separators)', !/[\\/]/.test((d.url ?? '').replace('upload://', '')), String(d.url));
  }
  for (const j of await prisma.ingestionJob.findMany({ where: { params: { path: ['filename'], string_contains: RUN } }, select: { id: true } })) jobIds.add(j.id);

  // ── crash recovery: an upload request that died mid-flight ──
  const crashed = await prisma.ingestionJob.create({
    data: { type: 'PDF_INGEST', status: 'RUNNING', startedAt: new Date(Date.now() - 31 * 60_000), params: { upload: true, filename: `crash-${RUN}.pdf`, bytes: 1 } },
  });
  const live = await prisma.ingestionJob.create({
    data: { type: 'PDF_INGEST', status: 'RUNNING', startedAt: new Date(), params: { upload: true, filename: `live-${RUN}.pdf`, bytes: 1 } },
  });
  jobIds.add(crashed.id); jobIds.add(live.id);
  const list = await call('/api/admin/ingestion/status', { cookie });
  const byId = new Map<string, any>((list.body.jobs ?? []).map((j: any) => [j.id, j]));
  check('crashed upload becomes FAILED when status is read', byId.get(crashed.id)?.status === 'FAILED' && /interrupted/i.test(byId.get(crashed.id)?.error ?? ''), JSON.stringify(byId.get(crashed.id)?.status));
  check('in-progress upload is left RUNNING', (await prisma.ingestionJob.findUniqueOrThrow({ where: { id: live.id } })).status === 'RUNNING');

  // ── sources API: validation, duplicates, pause, auto-crawl contract ──
  const srcName = `http-src-${RUN}`;
  const mkSource = (body: object, ck = cookie) => postJson('/api/admin/sources', { name: srcName, type: 'WEBSITE', ...body }, ck);
  const sourceIds: string[] = [];
  check('source: unauthenticated → 401', (await postJson('/api/admin/sources', { name: 'x', type: 'WEBSITE', rootUrl: 'https://goldensierra.com/x' })).status === 401);
  check('source: VIEWER → 403', (await mkSource({ rootUrl: 'https://goldensierra.com/x' }, viewer)).status === 403);
  const noHost = await mkSource({ rootUrl: 'https://127.0.0.1/' });
  check('source: a private address → 400, naming the host and the reason', noHost.status === 400 && /private|loopback|reserved/i.test(noHost.body.error) && noHost.body.details?.reason === 'blocked_address' && noHost.body.details?.host === '127.0.0.1', JSON.stringify(noHost.body));
  const metadata = await mkSource({ rootUrl: 'https://169.254.169.254/latest/meta-data/' });
  check('source: cloud metadata address → 400', metadata.status === 400 && metadata.body.details?.reason === 'blocked_address', JSON.stringify(metadata.body));
  const plainHttp = await mkSource({ rootUrl: 'http://goldensierra.com/' });
  check('source: plain http:// → 400 (HTTPS required)', plainHttp.status === 400 && plainHttp.body.details?.reason === 'bad_scheme', JSON.stringify(plainHttp.body));
  const creds = await mkSource({ rootUrl: 'https://user:topsecret@goldensierra.com/' });
  check('source: embedded credentials → 400, never echoed', creds.status === 400 && !JSON.stringify(creds.body).includes('topsecret'), JSON.stringify(creds.body));
  const robotsOff = await mkSource({ rootUrl: 'https://goldensierra.com/x', respectRobots: false });
  check('source: robots.txt compliance cannot be turned off → 400', robotsOff.status === 400, JSON.stringify(robotsOff.body));
  const badScheme = await mkSource({ rootUrl: 'ftp://goldensierra.com/' });
  check('source: non-http scheme → 400', badScheme.status === 400, JSON.stringify(badScheme.body));
  const shortName = await postJson('/api/admin/sources', { name: 'x', type: 'WEBSITE', rootUrl: 'https://goldensierra.com/x' }, cookie);
  check('source: schema errors come back as issues[]', shortName.status === 400 && Array.isArray(shortName.body.issues) && shortName.body.issues.length > 0, JSON.stringify(shortName.body));
  const dupReal = await mkSource({ rootUrl: 'https://www.goldensierra.com' });
  check('source: duplicate of an existing real source (www/trailing-slash variant) → 409', dupReal.status === 409 && dupReal.body.code === 'duplicate_source', JSON.stringify(dupReal.body));

  const jobsBeforeSrc = await prisma.ingestionJob.count();
  const created = await mkSource({ rootUrl: `https://goldensierra.com/http-test-${RUN}`, startCrawl: false });
  check('source: created with startCrawl:false → 201 and NO job queued', created.status === 201 && created.body.crawl === null && (await prisma.ingestionJob.count()) === jobsBeforeSrc, JSON.stringify(created.body).slice(0, 200));
  const srcId: string | undefined = created.body.source?.id;
  if (srcId) {
    sourceIds.push(srcId);
    check('source: the same URL again → 409', (await mkSource({ rootUrl: `https://www.goldensierra.com/http-test-${RUN}/` })).status === 409);
    const list = (await call('/api/admin/sources', { cookie })).body.sources.find((x: any) => x.id === srcId);
    check('source list exposes enabled-state, doc state and retrieval readiness separately', list?.status === 'ACTIVE' && list?.documents?.indexed === 0 && list?.retrieval?.state === 'not_ready' && list?.lastJob === null, JSON.stringify(list));
    check('PATCH pause → 200', (await call(`/api/admin/sources/${srcId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'PAUSED' }), cookie })).status === 200);
    const paused = await postJson('/api/admin/ingestion', { type: 'CRAWL', sourceId: srcId }, cookie);
    check('crawling a paused source → 400 "paused"', paused.status === 400 && /paused/i.test(paused.body.error), JSON.stringify(paused.body));
    check('…and no job was created for it', (await prisma.ingestionJob.count({ where: { sourceId: srcId } })) === 0);
    check('VIEWER cannot delete a source → 403', (await call(`/api/admin/sources/${srcId}`, { method: 'DELETE', cookie: viewer })).status === 403);
  }
  for (const id of sourceIds) await call(`/api/admin/sources/${id}`, { method: 'DELETE', cookie });

  // ── cleanup (own rows only) ──
  for (const id of documentIds) await deleteByDocument(id).catch(() => undefined);
  await prisma.document.deleteMany({ where: { id: { in: [...documentIds] } } });
  await prisma.ingestionJob.deleteMany({ where: { id: { in: [...jobIds] } } });
  await prisma.adminUser.delete({ where: { id: viewerUser.id } });
  check('cleanup restored source count', (await prisma.knowledgeSource.count()) === sourcesAtStart);
  check('cleanup restored job + document counts', (await prisma.ingestionJob.count()) === jobsAtStart && (await prisma.document.count()) === docsAtStart,
    `jobs ${await prisma.ingestionJob.count()}/${jobsAtStart} docs ${await prisma.document.count()}/${docsAtStart}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
