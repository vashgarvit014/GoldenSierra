import { prisma } from '../db';

/**
 * Links catalogue programs to the indexed documents that actually describe them.
 *
 * A link is created only when an INDEXED, PUBLIC document on the program's own official host has a
 * chunk that names the program (its name, singular or plural, or a parenthetical alias such as
 * "Wage Reimbursement"). Keywords never link: "young adult" or "job search" are topics, not names.
 * Governance records (board agendas, packets, minutes) and the sitemap are not linked.
 * Links are additive (ProgramDocument rows); nothing in the knowledge base is changed or deleted.
 * The same naming test decides, at answer time, whether a cited chunk may produce a program card.
 */

type ProgramLike = { name: string };

const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');

/** Phrases that identify a program when they appear in a passage. */
export function namingPhrases(p: ProgramLike): string[] {
  const base = p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const inParens = [...p.name.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.trim());
  // "Veterans Priority of Service" is called "priority of service" on the page: the name without its
  // leading audience word counts when at least two words remain.
  const words = base.split(/\s+/);
  const tail = words.length >= 3 ? words.slice(1).join(' ') : '';
  const phrases = [base, base.replace(/s$/i, ''), tail, ...inParens];
  return [...new Set(phrases.map(norm).filter((x) => x.length >= 6))];
}

/** The first phrase of `p` that `text` contains, or null. */
export function namedIn(text: string, p: ProgramLike): string | null {
  const t = norm(text);
  return namingPhrases(p).find((ph) => new RegExp(`(^|[^a-z])${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t)) ?? null;
}

const hostOf = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/** Governance records and navigation pages mention programs without describing them to the public. */
const NOT_DESCRIPTIVE = /agenda|packet|minutes|bylaws|sitemap/i;

export type LinkPlan = { slug: string; name: string; documents: { id: string; title: string; url: string | null; phrase: string }[] };

/** Computes (and unless dryRun, stores) the program → document links. Returns the plan either way. */
export async function linkProgramsToDocuments({ dryRun = false } = {}): Promise<LinkPlan[]> {
  const programs = await prisma.program.findMany({ where: { status: 'ACTIVE' }, select: { id: true, slug: true, name: true, officialUrl: true } });
  const docs = await prisma.document.findMany({
    where: { status: 'INDEXED', accessLevel: 'PUBLIC' },
    select: { id: true, title: true, url: true, chunks: { select: { content: true, headingPath: true } } },
  });
  const plans: LinkPlan[] = [];
  for (const p of programs) {
    const host = hostOf(p.officialUrl);
    const plan: LinkPlan = { slug: p.slug, name: p.name, documents: [] };
    if (host) {
      for (const d of docs) {
        if (hostOf(d.url) !== host || NOT_DESCRIPTIVE.test(`${d.title} ${d.url}`)) continue;
        for (const c of d.chunks) {
          const phrase = namedIn(`${c.headingPath ?? ''} ${c.content}`, p);
          if (phrase) {
            plan.documents.push({ id: d.id, title: d.title, url: d.url, phrase });
            break;
          }
        }
      }
    }
    plans.push(plan);
    if (!dryRun && plan.documents.length) {
      await prisma.programDocument.createMany({ data: plan.documents.map((d) => ({ programId: p.id, documentId: d.id })), skipDuplicates: true });
    }
  }
  return plans;
}
