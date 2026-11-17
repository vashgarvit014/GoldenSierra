import type { Recommendation } from './chat';

/** Role-based results and real narrowing counts for the Workforce Navigator. */

export type MatchKind = 'exact' | 'related' | 'transferable' | 'sector';
export type ListingStatus = 'open_until' | 'open_until_filled' | 'closed' | 'unknown';

export type JobRequirement = {
  /** Verbatim from the listing. */
  text: string;
  about: 'education' | 'experience' | 'certification' | 'age' | 'other';
  /** False for "preferred" / "desirable" items and for things provided after hire. */
  mandatory: boolean;
  /** "Provided after hire": shown, never a prerequisite. */
  informational?: boolean;
  /** Number of alternative ways to meet it ("… OR …"), when more than one. */
  alternatives?: number;
  /** Against what the user has told us: met, not met, or not known yet. Never an eligibility decision. */
  status: 'met' | 'unmet' | 'unknown';
  /** What the user has said that bears on it, in plain words. */
  comparison: string;
  educationLevel?: string;
  /** Facts that would decide it (edu, exp:<sector>, cert:<slug>, age) — used to choose questions. */
  decidedBy: string[];
  /** Where the requirement is published: the listing column and the indexed chunks that contain it. */
  source: { field: 'qualifications' | 'requiredSkills'; chunkIds: string[] };
};

export type QualificationSummary = {
  published: number;
  mandatory: number;
  met: number;
  unmet: number;
  unknown: number;
  /** Mandatory requirements they have said they don't meet (verbatim). */
  missing: string[];
  fit: 'meets_published' | 'incomplete' | 'gaps' | 'no_published_requirements';
};

export type JobMatch = {
  id: string;
  title: string;
  employer: string | null;
  county: string | null;
  location: string | null;
  occupation: { key: string; title: string; sector: string } | null;
  kind: MatchKind;
  relation: 'related' | 'supervisory' | 'step_down' | null;
  reasons: string[];
  skillsAlignment: string[];
  requirements: JobRequirement[];
  qualification: QualificationSummary;
  /** Getting there: listing location vs. where they are and their transport (not a published requirement). */
  access: string | null;
  salary: string | null;
  employmentType: string | null;
  summary: string | null;
  requiredSkills: string | null;
  applyUrl: string | null;
  sourceUrl: string | null;
  contact: string | null;
  datePosted: string | null;
  deadline: string | null;
  listingStatus: ListingStatus;
  listingStatusLabel: string;
  source: { documentId: string; title: string; url: string | null; indexedAt: string; chunkIds: string[] };
  rank: number;
};

export type NarrowingCounts = {
  /** Job listings: all indexed, related to their roles, open, and with a published requirement they don't meet. */
  listings: { total: number; relevant: number; closed: number; unmet: number; open: number };
  /** Catalogue services: total, excluded by a confirmed rule, still possible, and how many need staff confirmation. */
  programs: { total: number; excluded: number; possible: number; unconfirmed: number };
};

export type NavigatorResults = {
  bestJobs: JobMatch[];
  relatedJobs: JobMatch[];
  /** Listings with a mandatory published requirement they said they don't meet. */
  gapJobs: JobMatch[];
  training: Recommendation[];
  support: Recommendation[];
  /** Roles searched: what they have/want, and the related roles the search was widened to. */
  roleSearch: { own: string[]; related: string[] };
};
