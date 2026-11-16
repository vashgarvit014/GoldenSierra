/**
 * A tiny, fully controlled website for crawl tests. Its content is fictional
 * and unique, so anything the chatbot says about it must have come from this
 * crawl and nowhere else.
 *   PORT=4455 npx tsx tests/e2e/fixtures/test-site.ts
 */
import http from 'node:http';

export const SITE_FACTS = {
  program: 'Quillfeather Welding Fellowship',
  stipend: '$4,217 per month',
  permit: 'Class Q permit',
  hall: 'Brambleton Annex Hall',
  contact: 'Ottoline Fenwick-Marsh',
};

const nav = '<nav><a href="/">Home</a> <a href="/fellowship">Fellowship</a> <a href="/locations">Locations</a></nav>';
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${nav}<main><h1>${title}</h1>${body}</main></body></html>`;

export const PAGES: Record<string, string> = {
  '/': page(
    'Quillfeather Training Collective',
    `<p>The Quillfeather Training Collective is a fictional workforce organisation used only for software testing. It offers hands-on trades programs for adult learners across the imaginary Brambleton region, including the ${SITE_FACTS.program}, a paid pathway into structural welding careers.</p>
     <p>Learners who finish the collective's programs receive a portable credential that is recognised across the region. Staff are available on weekday mornings to answer questions about enrollment, schedules and support services for new participants.</p>`,
  ),
  '/fellowship': page(
    `${SITE_FACTS.program}`,
    `<h2>Who can apply</h2>
     <p>The ${SITE_FACTS.program} is open to residents of Alpine County who hold a ${SITE_FACTS.permit} and are at least eighteen years old. Applicants do not need prior welding experience, because the first six weeks of training cover safety, blueprint reading and basic joint preparation. It is a career training pathway for people who want to find a job in the trades, and it includes resume and interview coaching.</p>
     <h2>What it pays</h2>
     <p>Fellows receive a stipend of ${SITE_FACTS.stipend} while they train, plus a tool allowance paid in the third week. The stipend continues for up to nine months, after which graduates receive an introduction to local fabrication shops.</p>
     <h2>How to enrol</h2>
     <p>Contact ${SITE_FACTS.contact}, the fellowship coordinator, to book an orientation session. Bring identification and proof of residency to the first meeting.</p>`,
  ),
  '/locations': page(
    'Training locations',
    `<p>All Quillfeather classes meet at the ${SITE_FACTS.hall}, a converted grain warehouse beside the old railway depot. The hall has a loading bay, six welding bays with ventilation, and a quiet classroom for theory lessons held on Tuesday and Thursday evenings.</p>
     <p>Parking is free on the north lot, and the number nine shuttle stops directly outside the main doors every twenty minutes during class hours. Accessible entrances are available on both the east and west sides of the building.</p>`,
  ),
};

export function startTestSite(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
      return;
    }
    const body = PAGES[path];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('test-site.ts')) {
  const port = Number(process.env.PORT ?? 4455);
  void startTestSite(port).then(() => console.log(`test site on http://127.0.0.1:${port}/`));
}
