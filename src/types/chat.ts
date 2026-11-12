/**
 * Shared contract between the RAG pipeline, the API layer and the UI.
 * Kept free of server-only imports so client components can use it.
 */

export const INTENTS = [
  'find_job',
  'find_training',
  'financial_assistance',
  'career_counseling',
  'internship',
  'eligibility',
  'employer_hiring',
  'employer_training',
  'local_services',
  'contact_referral',
  'general_info',
  'off_topic',
] as const;

export type Intent = (typeof INTENTS)[number];

export const INTENT_LABELS: Record<Intent, string> = {
  find_job: 'Looking for employment',
  find_training: 'Searching for job training',
  financial_assistance: 'Requesting financial assistance',
  career_counseling: 'Seeking career counseling',
  internship: 'Looking for an internship',
  eligibility: 'Asking about eligibility',
  employer_hiring: 'Employer hiring assistance',
  employer_training: 'Employee training support',
  local_services: 'Finding local workforce services',
  contact_referral: 'Requesting contact or referral information',
  general_info: 'General questions about Golden Sierra',
  off_topic: 'Outside the scope of workforce services',
};

export const COUNTY_NAMES = ['Placer', 'El Dorado', 'Alpine'] as const;
export type CountyName = (typeof COUNTY_NAMES)[number];

export type EmploymentStatus =
  | 'unemployed'
  | 'employed'
  | 'underemployed'
  | 'laid_off'
  | 'student'
  | 'unknown';

/**
 * What the assistant has learned about the person across the conversation.
 * Deliberately narrow: only workforce-relevant facts a user volunteered. No
 * name, address, SSN, or date of birth is ever extracted or stored.
 */
export type UserProfile = {
  county?: CountyName;
  /** Free text when a user names a city we cannot map to a served county. */
  locationText?: string;
  employmentStatus?: EmploymentStatus;
  audience?: 'job_seeker' | 'employer';
  careerInterests?: string[];
  existingSkills?: string[];
  trainingNeeds?: string[];
  preferredSector?: string;
  isVeteran?: boolean;
  ageBand?: 'under_18' | '18_24' | '25_54' | '55_plus';
  hasDisability?: boolean;
  requestedHelp?: string[];
};

export type QueryAnalysis = {
  intent: Intent;
  /** 0-1; low confidence makes the assistant ask rather than assume. */
  confidence: number;
  /** Standalone question with pronouns resolved from history. */
  rewrittenQuery: string;
  /** Terms worth an exact keyword match (program names, counties). */
  keywords: string[];
  profileUpdates: UserProfile;
  /** The single most useful thing to ask, when something essential is missing. */
  missingInfo: string | null;
  isMultiPart: boolean;
  subQuestions: string[];
};

export type Citation = {
  id: number;
  title: string;
  url: string | null;
  /** ISO date of the last time the crawler confirmed this page. */
  lastVerified: string | null;
  documentType: string;
};

export type Recommendation = {
  programId: string | null;
  slug: string | null;
  name: string;
  shortDescription: string;
  /** Plain-English reason tied to what the user actually said. */
  whyRelevant: string;
  /** Only rules confirmed against a published source. */
  eligibility: { description: string; sourceUrl: string | null; verified: boolean }[];
  nextSteps: string | null;
  officialUrl: string | null;
  contactPhone: string | null;
  /** True when eligibility cannot be confirmed from published sources. */
  requiresVerification: boolean;
  /** Set when a deterministic rule rules the user out; shown as a caveat. */
  exclusions: string[];
  category: string | null;
};

export type RetrievedSource = {
  chunkId: string;
  documentId: string;
  title: string;
  url: string | null;
  snippet: string;
  score: number;
  rerankScore?: number;
  headingPath: string | null;
  category: string | null;
  lastVerified: string | null;
  documentType: string;
  /** Whether this passage was actually passed to the model. */
  used: boolean;
};

export type ConflictNote = {
  topic: string;
  description: string;
  sources: { title: string; url: string | null; lastVerified: string | null }[];
};

/** Everything the UI needs to render one assistant turn. */
export type AssistantPayload = {
  intent: Intent;
  confidence: number;
  recommendations: Recommendation[];
  citations: Citation[];
  sources: RetrievedSource[];
  followUpSuggestions: string[];
  conflicts: ConflictNote[];
  /** False when retrieval found nothing usable; the UI shows a fallback note. */
  grounded: boolean;
  profile: UserProfile;
  /** Present when the assistant needs one more detail to be useful. */
  clarifyingQuestion: string | null;
  latencyMs: number;
};

export type ChatTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload?: AssistantPayload;
  createdAt: string;
};

export const STARTER_QUESTIONS = [
  'What services does Golden Sierra provide?',
  'Can I get help finding a job?',
  'Are there training scholarships available?',
  'I am unemployed. What assistance can I receive?',
  'How can Golden Sierra help my business hire employees?',
] as const;
