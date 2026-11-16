/**
 * Counselor-mode conversation contract.
 *
 * Shared by the engine, the API and the UI, and deliberately free of
 * server-only imports so client components can use it directly.
 *
 * The design follows the brief's central rule: the assistant understands
 * before it recommends. Everything here exists to support one adaptive
 * question at a time, with honest counts and carefully handled assumptions.
 */

export type SessionMode = 'self' | 'helper';

/** Who the conversation is about — "she" in helper mode, "you" in self mode. */
export type Subject = { pronoun: 'you' | 'they'; possessive: 'your' | 'their' };

export const SUBJECT: Record<SessionMode, Subject> = {
  self: { pronoun: 'you', possessive: 'your' },
  helper: { pronoun: 'they', possessive: 'their' },
};

export type Transportation = 'own_vehicle' | 'transit_only' | 'none' | 'unknown';
export type IncomeUrgency = 'immediate' | 'can_train_first' | 'flexible' | 'unknown';
export type EducationLevel =
  | 'no_hs_diploma'
  | 'working_on_ged'
  | 'ged_or_hs'
  | 'some_college'
  | 'degree'
  | 'unknown';

/** Populations the agency names on its public pages. */
export type PopulationTag =
  | 'former_foster_youth'
  | 'veteran'
  | 'youth'
  | 'disability'
  | 'low_income'
  | 'dislocated_worker'
  | 'english_learner'
  | 'justice_involved';

export const POPULATION_LABELS: Record<PopulationTag, string> = {
  former_foster_youth: 'Former foster youth',
  veteran: 'Veteran',
  youth: 'Young adult (16–24)',
  disability: 'Disability or accommodation need',
  low_income: 'Low income',
  dislocated_worker: 'Laid off / dislocated worker',
  english_learner: 'English language learner',
  justice_involved: 'Justice involved',
};

/**
 * Everything the conversation has learned. Only workforce-relevant facts the
 * user volunteered — never a name, address, SSN or date of birth.
 */
export type CounselorContext = {
  mode: SessionMode;
  age?: number;
  ageBand?: 'under_18' | '18_24' | '25_54' | '55_plus';
  county?: 'Placer' | 'El Dorado' | 'Alpine';
  city?: string;
  population: PopulationTag[];
  careerInterest?: string;
  desiredTraining?: string;
  education?: EducationLevel;
  employmentStatus?: 'unemployed' | 'employed' | 'underemployed' | 'laid_off' | 'student';
  transportation?: Transportation;
  incomeUrgency?: IncomeUrgency;
  timeForTraining?: 'weeks' | 'months' | 'unknown';
  barriers: string[];
  audience?: 'job_seeker' | 'employer';
};

export type ContextFieldKey = keyof CounselorContext;

/** One fact shown in the "What I know so far" panel. */
export type KnownFact = {
  key: string;
  /** What the user actually said, in their terms. */
  label: string;
  /** The dimension it informs — "Population", "Geography", … */
  dimension: string;
  /** `known` renders a tick, `pending` an open circle. */
  state: 'known' | 'pending';
  /** True when inferred rather than stated, so the UI can offer a correction. */
  inferred?: boolean;
};

/**
 * An interpretation the system is relying on. Internal only: it is not
 * rendered as a dedicated notice. Uncertainty that matters reaches the user
 * in the relevant recommendation ("Staff confirm", "Worth checking") or as a
 * normal follow-up question. Never silently promoted to fact.
 */
export type Assumption = {
  id: string;
  text: string;
  basis: string;
};

export type QuickReply = {
  /** Shown on the button. */
  label: string;
  /** Submitted as a genuine user message — never a decorative button. */
  value: string;
};

/** Four-state eligibility, per the brief. Absence of evidence is not exclusion. */
export type MatchState = 'eligible' | 'potential' | 'needs_verification' | 'mismatch';

export type ProgramMatch = {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  state: MatchState;
  /** Plain-English reasons this is still a candidate. */
  reasons: string[];
  /** What would have to be confirmed, and by whom. */
  openQuestions: string[];
  officialUrl: string | null;
  contactPhone: string | null;
  nextSteps: string | null;
  counties: string[];
  category: string | null;
};

export type ConversationStage =
  | 'start'
  | 'understanding'
  | 'clarification'
  | 'ready_for_results'
  | 'results';

/** Narrowing indicator. Nullable throughout — never invent a total. */
export type NarrowingState = {
  /** Candidates still in play, or null when matching cannot run yet. */
  candidates: number | null;
  /** The real catalogue size. Null rather than a fabricated number. */
  total: number | null;
  /** Context dimensions considered so far, for the dot visualisation. */
  criteria: { key: string; label: string; applied: boolean }[];
  /** One line explaining what the count means right now. */
  explanation: string;
};

/** The validated structure every counselor turn returns. */
export type CounselorTurn = {
  stage: ConversationStage;
  /** The conversational body — acknowledgement plus observation. */
  message: string;
  /** The single follow-up, already folded into `message` when present. */
  nextQuestion: string | null;
  quickReplies: QuickReply[];
  assumption: Assumption | null;
  knownFacts: KnownFact[];
  narrowing: NarrowingState;
  context: CounselorContext;
  /** Populated only at the results stage. */
  recommendations: ProgramMatch[];
  sources: { id: number; title: string; url: string | null }[];
  /** True once enough is known that "See Results" is worth offering. */
  canShowResults: boolean;
  grounded: boolean;
};

export type CounselorMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  turn?: CounselorTurn;
  createdAt: string;
};

/** Openers shown before the first message, per mode. */
export const MODE_OPENERS: Record<SessionMode, { title: string; body: string; replies: string[] }> = {
  self: {
    title: 'What brings you here today?',
    body: "Tell me a bit about your situation — what you're looking for, and anything that makes it tricky. I'll ask a few short questions and then point you to what fits.",
    replies: [
      'I need to find a job',
      'I want training for a new career',
      'I need help paying for training',
      "I'm not sure where to start",
    ],
  },
  helper: {
    title: 'Who are you helping?',
    body: "Tell me about the person you're supporting — their situation, what they're aiming for, and anything standing in the way. I'll ask a few short questions, then narrow it down.",
    replies: [
      "I'm helping a young adult",
      "I'm helping someone who was laid off",
      "I'm helping a client find training",
      "I'm not sure what they qualify for",
    ],
  },
};
