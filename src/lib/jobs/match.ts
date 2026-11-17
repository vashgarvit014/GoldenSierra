import { prisma } from '../db';
import { logger } from '../logger';
import { OCCUPATION_BY_KEY, SECTOR_LABELS, relatedOf, sectorFor, skillsIn, type RelationKind } from './occupations';
import { SUBJECT, type CounselorContext } from '@/types/counselor';
import type { JobMatch, JobRequirement, ListingStatus, MatchKind } from '@/types/navigator';

/**
 * Role-based job matching over the structured listings (JobListing), not over keywords.
 *
 *   exact         the listing's occupation is a role they want or have done
 *   related       an occupation next to theirs in the taxonomy (incl. a step up to a lead role)
 *   transferable  the listing asks for two or more skills they said they have
 *   sector        a role in the field they said they're interested in
 *
 * Ranking is explainable and deterministic: kind, then published requirements they don't meet,
 * then location, then whether the listing's deadline has passed. No percentages. Every displayed
 * field comes from the listing row, which was verified verbatim against its source document; the
 * card links to the document chunks that contain the listing.
 */

const KIND_RANK: Record<MatchKind, number> = { exact: 4, related: 3, transferable: 2, sector: 1 };

export type ListingRow = Awaited<ReturnType<typeof loadListings>>[number];

export async function loadListings() {
  return prisma.jobListing.findMany({
    where: { document: { status: 'INDEXED', accessLevel: 'PUBLIC' } },
    include: { document: { select: { id: true, title: true, url: true, lastVerifiedAt: true, createdAt: true } } },
    orderBy: [{ documentId: 'asc' }, { ordinal: 'asc' }],
  });
}

export function roleProfile(ctx: CounselorContext) {
  const own = [...new Set([...(ctx.occupations ?? []), ...(ctx.experience ?? [])])];
  const related = relatedOf(own);
  // "Hands-on technical work" drops lead roles; "supervisory" keeps them and the lateral moves.
  if (ctx.rolePreference === 'technical') for (const [k, kind] of related) if (kind === 'supervisory') related.delete(k);
  return { own, related, sector: sectorFor(ctx.careerInterest) ?? (own[0] ? OCCUPATION_BY_KEY.get(own[0])?.sector ?? null : null), skills: ctx.skills ?? [] };
}

const DATE = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/;

/** Open/closed per the listing's own deadline text. Never "verified current" — only what the listing says. */
export function listingStatus(deadline: string | null, today = new Date()): { status: ListingStatus; label: string } {
  if (!deadline) return { status: 'unknown', label: 'No deadline listed' };
  if (/until filled|continuous|ongoing|rolling/i.test(deadline)) {
    const m = DATE.exec(deadline);
    return { status: 'open_until_filled', label: m ? `Open until filled (listing mentions ${m[0]})` : 'Open until filled, per the listing' };
  }
  const m = DATE.exec(deadline);
  if (!m) return { status: 'unknown', label: `Deadline: ${deadline}` };
  const d = m[1] ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59) : new Date(Number(m[6]), Number(m[4]) - 1, Number(m[5]), 23, 59);
  return d < today ? { status: 'closed', label: `Deadline passed (${m[0]})` } : { status: 'open_until', label: `Apply by ${m[0]}` };
}

/** Each published qualification, verbatim, with whether what they've told us meets it. */
export function requirementsFor(l: Pick<ListingRow, 'qualifications' | 'county' | 'location'>, ctx: CounselorContext): JobRequirement[] {
  const out: JobRequirement[] = [];
  for (const raw of (l.qualifications ?? '').split(/;\s*/).map((x) => x.trim()).filter(Boolean)) {
    const t = raw.toLowerCase();
    let status: JobRequirement['status'] = 'unknown';
    let about: JobRequirement['about'] = 'other';
    if (/\b(hs diploma|high school|12th grade|ged)\b/.test(t)) {
      about = 'education';
      if (ctx.education === 'no_hs_diploma' || ctx.education === 'working_on_ged') status = /or equivalent experience/.test(t) ? 'unknown' : 'unmet';
      else if (ctx.education) status = 'met';
    } else if (/\b(bachelor'?s|associate'?s|degree)\b/.test(t)) {
      about = 'education';
      const optional = /preferred|desirable|or equivalent/.test(t);
      if (ctx.education === 'degree') status = 'met';
      else if (ctx.education && !optional) status = 'unmet';
      if (optional) about = 'education_preferred';
    } else if (/driver'?s licen[cs]e/.test(t)) about = 'license';
    else if (/\b\d+\s*(\+|-\s*\d+)?\s*(yrs?|years?)\b/.test(t)) about = 'experience';
    else if (/certif|licen[cs]e/.test(t)) about = 'certification';
    if (/no formal eligibility/i.test(t)) continue;
    out.push({ text: raw, about, status });
  }
  return out;
}

function chunkIdsFor(row: ListingRow, chunks: { id: string; documentId: string; content: string }[]): string[] {
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const title = squash(row.title);
  const employer = row.employer ? squash(row.employer) : null;
  return chunks.filter((c) => c.documentId === row.documentId && squash(c.content).includes(title) && (!employer || squash(c.content).includes(employer.slice(0, 20)))).map((c) => c.id);
}

/** Scores every listing against the context; listings with no occupational relation are not returned. */
export function scoreListings(rows: ListingRow[], ctx: CounselorContext, chunks: { id: string; documentId: string; content: string }[] = []): JobMatch[] {
  const p = roleProfile(ctx);
  const s = SUBJECT[ctx.mode];
  const out: JobMatch[] = [];
  for (const l of rows) {
    const occ = l.occupations.map((k) => OCCUPATION_BY_KEY.get(k)).filter(Boolean)[0];
    const listingSkills = skillsIn(`${l.requiredSkills ?? ''} ${l.summary ?? ''}`);
    const overlap = p.skills.filter((x) => listingSkills.includes(x));
    let kind: MatchKind | null = null;
    let relation: RelationKind | null = null;
    const reasons: string[] = [];
    const exact = l.occupations.find((k) => p.own.includes(k));
    const rel = l.occupations.find((k) => p.related.has(k));
    if (exact) {
      kind = 'exact';
      const did = (ctx.experience ?? []).includes(exact);
      reasons.push(did ? `Uses ${s.possessive} experience as ${OCCUPATION_BY_KEY.get(exact)!.title.toLowerCase()}` : `The kind of role ${s.pronoun} are looking for (${OCCUPATION_BY_KEY.get(exact)!.title.toLowerCase()})`);
    } else if (rel) {
      kind = 'related';
      relation = p.related.get(rel)!;
      const from = p.own.map((k) => OCCUPATION_BY_KEY.get(k)!.title.toLowerCase()).join(' / ');
      reasons.push(relation === 'supervisory' ? `A lead or supervisory step from ${from}` : relation === 'step_down' ? `Close to ${from}, at a more entry-level step` : `An occupation related to ${from}`);
    } else if (overlap.length >= 2) {
      kind = 'transferable';
    } else if (p.sector && l.sector === p.sector) {
      kind = 'sector';
      const label = SECTOR_LABELS[p.sector].toLowerCase();
      reasons.push(`${/^[aeiou]/.test(label) ? 'An' : 'A'} ${label} role, the field ${s.pronoun} mentioned`);
    }
    if (!kind) continue;
    if (overlap.length) reasons.push(`The listing asks for ${overlap.slice(0, 3).join(', ')}, which ${s.pronoun} mentioned`);
    const inCounty = Boolean(ctx.county && l.county && l.county.toLowerCase().includes(ctx.county.toLowerCase()));
    const inTown = Boolean(ctx.city && `${l.location ?? ''}`.toLowerCase().includes(ctx.city));
    if (inTown) reasons.push(`Work location includes ${ctx.city!.replace(/\b\w/g, (c) => c.toUpperCase())}`);
    else if (inCounty) reasons.push(`In ${ctx.county} County, where ${s.pronoun} are`);
    const requirements = requirementsFor(l, ctx);
    if (ctx.county && l.county && !inCounty) requirements.push({ text: `Located in ${l.county}`, about: 'location', status: ctx.transportation === 'none' ? 'unmet' : 'unknown' });
    const status = listingStatus(l.deadline);
    const unmet = requirements.filter((r) => r.status === 'unmet').length;
    const chunkIds = chunkIdsFor(l, chunks);
    out.push({
      id: l.id,
      title: l.title,
      employer: l.employer,
      county: l.county,
      location: l.location,
      occupation: occ ? { key: occ.key, title: occ.title, sector: SECTOR_LABELS[occ.sector] } : null,
      kind,
      relation,
      reasons,
      skillsAlignment: overlap,
      requirements,
      salary: l.salary,
      employmentType: l.employmentType,
      summary: l.summary,
      requiredSkills: l.requiredSkills,
      applyUrl: l.applyUrl,
      sourceUrl: l.sourceUrl,
      contact: l.contact,
      datePosted: l.datePosted,
      deadline: l.deadline,
      listingStatus: status.status,
      listingStatusLabel: status.label,
      source: { documentId: l.document.id, title: l.document.title, url: l.document.url, indexedAt: (l.document.lastVerifiedAt ?? l.document.createdAt).toISOString(), chunkIds },
      rank: KIND_RANK[kind] * 10 - unmet * 3 + (inTown ? 3 : inCounty ? 2 : 0) - (status.status === 'closed' ? 100 : 0) + (relation === 'supervisory' && ctx.rolePreference === 'supervisory' ? 5 : 0),
    });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** Matches with their source chunks resolved from PostgreSQL. Never throws; an unavailable store yields []. */
export async function matchJobs(ctx: CounselorContext): Promise<{ matches: JobMatch[]; total: number }> {
  try {
    const rows = await loadListings();
    const chunks = await prisma.documentChunk.findMany({ where: { documentId: { in: [...new Set(rows.map((r) => r.documentId))] } }, select: { id: true, documentId: true, content: true } });
    // A card without a chunk it can cite is not shown.
    return { matches: scoreListings(rows, ctx, chunks).filter((m) => m.source.chunkIds.length > 0), total: rows.length };
  } catch (err) {
    logger.warn('Job listings unavailable', { error: String(err) });
    return { matches: [], total: 0 };
  }
}

/** Requirement verdicts of relevant open listings under a context — feeds question selection. */
export function jobVerdicts(rows: ListingRow[]) {
  return (ctx: CounselorContext) =>
    scoreListings(rows, ctx)
      .filter((m) => m.listingStatus !== 'closed')
      .map((m) => `${m.id}:${m.kind}:${m.requirements.map((r) => r.status[0]).join('')}`)
      .join('|');
}
