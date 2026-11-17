/**
 * Qualification-aware ranking vs. role-only grouping, on the REAL indexed listings (read only).
 * For each persona (stated facts only), counts the open listings each approach would show as "best
 * matches", and how many of those have a mandatory published requirement the person said they don't meet
 * or that is still unknown. Role-only = the previous grouping (exact role ⇒ best match).
 *
 *   npx tsx scripts/eval-qualification.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { loadListings, scoreListings } from '../src/lib/jobs/match';
import { mergeContext, ruleExtract } from '../src/lib/counselor/extract';
import type { CounselorContext } from '../src/types/counselor';

const PERSONAS: { label: string; mode: 'self' | 'helper'; says: string[] }[] = [
  { label: 'electrician, 2 years', mode: 'self', says: ['I worked as an electrician for 2 years.'] },
  { label: 'electrician, 6 years + license', mode: 'self', says: ["I worked as an electrician for 6 years and I have a valid driver's license."] },
  { label: 'clerk seeker, no diploma (helper)', mode: 'helper', says: ["I'm helping someone who wants an office clerk job. He didn't finish high school and has no GED."] },
  { label: 'bookkeeper, no degree', mode: 'self', says: ["I did bookkeeping in QuickBooks for 3 years. I don't have a college degree."] },
  { label: 'foster youth, healthcare, no GED (helper)', mode: 'helper', says: ["I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED."] },
  { label: 'solar installer, 3 years', mode: 'self', says: ['I have 3 years of experience installing solar panels.'] },
  { label: 'housekeeping supervisor, 1 year', mode: 'self', says: ['I supervised housekeepers at a hotel for 1 year.'] },
];

(async () => {
  const rows = await loadListings();
  const out: { persona: string; roleOnlyBest: string; roleOnlyBestWithStatedUnmet: number; qualAwareBest: string; qualAwareBestWithStatedUnmet: number; shownAsNeedsQualification: string; mandatoryChecked: number; mandatoryUnknown: number }[] = [];
  for (const p of PERSONAS) {
    let ctx: CounselorContext = { mode: p.mode, population: [], barriers: [] };
    for (const m of p.says) ctx = mergeContext(ctx, ruleExtract(m, ctx));
    const open = scoreListings(rows, ctx).filter((m) => m.listingStatus !== 'closed');
    const roleOnly = open.filter((m) => m.kind === 'exact');
    const qualAware = open.filter((m) => m.kind === 'exact' && m.qualification.unmet === 0);
    const gaps = open.filter((m) => m.qualification.unmet > 0);
    out.push({
      persona: p.label,
      roleOnlyBest: roleOnly.map((m) => m.title).join(' | ') || '—',
      roleOnlyBestWithStatedUnmet: roleOnly.filter((m) => m.qualification.unmet > 0).length,
      qualAwareBest: qualAware.map((m) => `${m.title} [${m.qualification.fit}]`).join(' | ') || '—',
      qualAwareBestWithStatedUnmet: qualAware.filter((m) => m.qualification.unmet > 0).length,
      shownAsNeedsQualification: gaps.map((m) => `${m.title}: ${m.qualification.missing.join('; ')}`).join(' | ') || '—',
      mandatoryChecked: open.reduce((n, m) => n + m.qualification.met + m.qualification.unmet, 0),
      mandatoryUnknown: open.reduce((n, m) => n + m.qualification.unknown, 0),
    });
  }
  for (const o of out) console.log(JSON.stringify(o, null, 1));
  const sum = (k: 'roleOnlyBestWithStatedUnmet' | 'qualAwareBestWithStatedUnmet' | 'mandatoryChecked' | 'mandatoryUnknown') => out.reduce((n, o) => n + o[k], 0);
  console.log(`\nbest matches with a stated-unmet mandatory requirement: role-only ${sum('roleOnlyBestWithStatedUnmet')}, qualification-aware ${sum('qualAwareBestWithStatedUnmet')}`);
  console.log(`mandatory requirements decided against stated facts: ${sum('mandatoryChecked')}; still unknown (shown as such): ${sum('mandatoryUnknown')}`);
  await prisma.$disconnect();
})();
