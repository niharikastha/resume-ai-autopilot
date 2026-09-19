/**
 * The only place that talks to the backend.
 *
 * credentials:'include' on every call, because auth is an HttpOnly cookie -
 * there is no token for this code to attach, by design (PLAN-v2 2A.6).
 */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3100';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Not signed in, or the session expired. */
  get isAuth(): boolean {
    return this.status === 401;
  }

  /** Signed in, but this role may not see it. Distinct from isAuth: retrying the
   *  login will not help, so the UI must say so rather than bounce to /login. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/**
 * The in-flight refresh, shared by every caller.
 *
 * The access cookie expires every 15 minutes, so a dashboard with six panels
 * will hit six simultaneous 401s. Without this, all six would POST /refresh, and
 * five of them would arrive holding a token the first one had already rotated -
 * which the server is entitled to read as a stolen token being replayed. One
 * promise, awaited by all six, is what keeps rotation from fighting concurrency.
 *
 * Module scope, so it is per-tab. Cross-tab races are handled server-side by the
 * grace window in auth.constants.ts, since separate tabs cannot share a promise.
 */
let refreshing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      // Cleared so the NEXT expiry can refresh again. Left set, this would
      // resolve instantly with a stale answer forever.
      refreshing = null;
    });
  return refreshing;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  // FormData is the one body this header must NOT be set for, and setting it is
  // not a cosmetic mistake: the server's json parser believes the header, tries to
  // parse the multipart body, and fails on the boundary line - which reaches the
  // screen as `Unexpected token '-', "------WebK"... is not valid JSON`. Measured
  // against the running API: with this header a resume upload is a 400 before any
  // guard runs; without it the same request is handled normally.
  //
  // Left unset, the browser fills it in itself, with the boundary parameter that
  // only the browser knows - see api.upload.
  const isForm = init?.body instanceof FormData;

  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
}

async function request<T>(
  path: string,
  init?: RequestInit,
  /** Internal. Prevents a refresh loop: the retry does not get its own retry. */
  allowRefresh = true,
): Promise<T> {
  let res = await send(path, init);

  // A 401 means the access cookie is stale, which is the ordinary state of any
  // tab left open for a quarter of an hour - not a sign-out. Spend one refresh
  // on it before believing the session is gone.
  //
  // The auth endpoints are excluded: a 401 from /login is a wrong password, and
  // trying to refresh past it would replace a clear error with a confusing one.
  if (
    res.status === 401 &&
    allowRefresh &&
    !path.startsWith('/api/auth/login') &&
    !path.startsWith('/api/auth/refresh')
  ) {
    if (await refreshSession()) {
      res = await send(path, init);
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join('; ');
      else if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  /** For a body that IS the whole resource - see /api/me/preferences. */
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /**
   * A multipart upload, and the ONE call that must not go through `api.post`.
   *
   * `api.post` calls JSON.stringify on the body, and FormData stringifies to
   * `{}` - so the file would silently not be sent at all. The content-type is
   * handled in `send`, which leaves it alone for FormData so the browser can add
   * the boundary parameter only it knows.
   */
  upload: <T>(path: string, file: File, field = 'file') => {
    const form = new FormData();
    form.append(field, file);
    return request<T>(path, { method: 'POST', body: form });
  },
};

// --- shapes the API returns -------------------------------------------------

export type Role = 'ADMIN' | 'USER';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  phase: string;
}

export type SourceStatus = 'healthy' | 'degraded' | 'dead';

export interface SourceHealth {
  source: string;
  boards: number;
  postings: number;
  lastRun: string | null;
  status: SourceStatus;
}

export interface AdminOverview {
  scope: 'admin';
  kpis: {
    companies: number;
    activeCompanies: number;
    postings: number;
    addressable: number;
    scored: number;
    awaitingReview: number;
    prepared: number;
    submitted: number;
  };
  funnel: FunnelStage[];
  applications: Record<string, number>;
  sourceHealth: SourceHealth[];
  scoreDistribution: { bucket: number; label: string; count: number }[];
  lastRun: { source: string; startedAt: string; postingsSeen: number } | null;
}

export interface UserOverview {
  scope: 'user';
  profile: {
    id: string;
    label: string;
    /** True when this is the resume matching and tailoring actually use. The
     *  overview card reports on the selected one, so without this the card cannot
     *  say whether what it is describing is the one in use. */
    isActive: boolean;
    confirmedAt: string | null;
    updatedAt: string;
  } | null;
  kpis: {
    scored: number;
    strongMatches: number;
    awaitingReview: number;
    prepared: number;
    submitted: number;
  };
  funnel: FunnelStage[];
  applications: Record<string, number>;
  recent: ApplicationRow[];
  blockers: { key: string; label: string; phase: string }[];
}

/** Where the candidate is willing to work, exactly as the save endpoint takes it. */
export interface StatedLocations {
  /** City ids from the catalogue below, never free text. */
  cities: string[];
  /** When true the city list is ignored: any Indian location is accepted. */
  anywhereInIndia: boolean;
  remoteIndia: boolean;
  /** Postings that say only "Remote" and name no country. Most Indian ones do. */
  remoteUnspecified: boolean;
  remoteOutsideIndia: boolean;
}

export interface IndiaCity {
  id: string;
  label: string;
  /** The spellings a posting might use. Shown so the screen can explain a choice. */
  terms: string[];
  metro: boolean;
}

export interface PreferencesView {
  locations: StatedLocations;
  /** False while config/targets.yaml's defaults are in force, so the UI can say so. */
  stated: boolean;
  catalogue: IndiaCity[];
  metroCityIds: string[];
  /** Open postings in these places. The location rule only - deliberately not a
   *  match count, see PreferencesService.countMatching. */
  matchingNow: number;
}

/** One recurring screening question the candidate has already answered by hand. */
export interface CustomAnswer {
  question: string;
  answer: string;
}

/**
 * The answers typed into application forms, exactly as the API sends and takes them.
 *
 * Money is a STRING on purpose: these go into a real employer's salary box, and a
 * JSON number round-trip is how 12.1 becomes 12.099999999999999. Null everywhere
 * means "not answered", which the form filler leaves blank rather than guessing.
 */
export interface StatedAnswers {
  workAuthorization: string | null;
  needsSponsorship: boolean | null;
  noticePeriodDays: number | null;
  currentCtcLpa: string | null;
  expectedCtcLpa: string | null;
  willingToRelocate: boolean | null;
  /** yyyy-mm-dd. */
  earliestStartDate: string | null;
  customAnswers: CustomAnswer[];
}

/**
 * The four answers an application cannot be prepared without, in the words a form uses.
 *
 * The KEYS are the truth and come from the server - `AnswersView.missing` names them.
 * This is only the translation, and it mirrors REQUIRED_ANSWER_LABEL in the backend's
 * submission/answers.ts. A key with no entry here falls back to the key itself, so a
 * fifth required answer added server-side shows up ugly rather than invisibly.
 */
export const REQUIRED_ANSWER_LABEL: Record<string, string> = {
  workAuthorization: 'Work authorisation',
  needsSponsorship: 'Whether you need sponsorship',
  noticePeriodDays: 'Notice period',
  expectedCtcLpa: 'Expected CTC',
};

/**
 * A question one of this candidate's own forms asked and nothing could answer.
 *
 * Read by the server out of the audit record every prepared application writes, so the
 * wording is the FORM'S wording - which is the wording that will match the next time it
 * is asked. Demographic boxes and declarations are not in here; those are not gaps.
 */
export interface AskedQuestion {
  question: string;
  /** How many prepared applications asked it. The reason to answer this one first. */
  timesAsked: number;
  lastAskedAt: string | null;
  /** True when at least one of those forms would not send without it. */
  required: boolean;
}

export interface AnswersView {
  answers: StatedAnswers;
  /** False until something has been saved at least once. */
  stated: boolean;
  updatedAt: string | null;
  /** Field names an application cannot be prepared without. Same list the daily
   *  digest and the dashboard blocker read. */
  missing: string[];
  /** Unanswered questions off real forms, commonest first. Already-answered ones are
   *  filtered out server-side; empty until an application has been prepared. */
  asked: AskedQuestion[];
  /** Starter questions for a library with nothing in it. Questions only - the server
   *  never sends an answer to go with one. */
  suggested: string[];
}

export interface ApplicationRow {
  id: string;
  status: string;
  prefillCoverage: number | null;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name: string; email: string };
  company: { name: string; tier: string };
  job: {
    title: string;
    location: string | null;
    applyUrl: string;
    atsType?: string;
    /** Same field, same reason, as MatchSuggestion.applyByHand. It is what stops a
     *  0% "form filled" reading as a prefill that failed. */
    applyByHand: boolean;
  };
  resumeVariant?: { pdfPath: string | null; guardPassed: boolean } | null;
}

export interface JobRow {
  id: string;
  title: string;
  location: string | null;
  source: string;
  remoteType: string;
  seniority: string | null;
  applyUrl: string;
  atsType: string;
  postedAt: string | null;
  firstSeenAt: string;
  /**
   * STRINGS, not numbers. These columns are `numeric` in Postgres so that a
   * salary figure is exact, and Prisma serializes a Decimal to a decimal string
   * rather than risk a float on the way through JSON. Typing them as `number`
   * here would be a lie the compiler could not catch, since nothing checks this
   * interface against the API at build time.
   */
  salaryMin: string | null;
  salaryMax: string | null;
  salaryCurrency: string | null;
  salaryPeriod: 'YEAR' | 'MONTH' | 'DAY' | 'HOUR' | null;
  company: { name: string; tier: string; atsType: string } | null;
  matchScores: { score: number; verdict: string }[];
}

/**
 * One employer on the jobs page, before it is expanded.
 *
 * `openPostings` counts only postings still open, so the number on a closed row and the
 * number of postings inside it when opened are the same number.
 *
 * `bestScore` is null rather than 0 when nothing here has been scored yet. A real 0
 * would read as "checked and hopeless"; null means "not looked at".
 */
export interface JobCompanyGroup {
  id: string;
  name: string;
  tier: string;
  atsType: string;
  isAgency: boolean;
  openPostings: number;
  scoredForYou: number;
  bestScore: number | null;
}

/**
 * One entry in the company filter's list.
 *
 * Deliberately two fields. The filter holds every employer at once so the list can be
 * searched without a round trip per keystroke, and a count or a score per row would make
 * that payload grow for information the filter does not show.
 */
export interface CompanyName {
  id: string;
  name: string;
}

/** One posting in an add-a-company scan, before anything has been saved. */
export interface ScannedPosting {
  title: string;
  location: string | null;
  applyUrl: string;
  remoteType: string;
  /** Whether the jobs page would count it under "roles that suit me". */
  suits: boolean;
}

/**
 * What the server found at a pasted URL. NOTHING HAS BEEN SAVED at this point.
 *
 * `scanId` is the only thing the save request sends back. The postings are held on the
 * server, so the browser cannot alter what gets written.
 */
export interface CompanyScan {
  scanId: string;
  url: string;
  name: string;
  slug: string;
  atsType: string;
  source: string;
  token: string | null;
  via: 'ats' | 'careers-page';
  existing: { id: string; name: string; slug: string } | null;
  postings: ScannedPosting[];
  suitable: number;
  writesPostingsNow: boolean;
  notes: string[];
}

export interface CompanyAdded {
  companyId: string;
  name: string;
  slug: string;
  created: number;
  updated: number;
  closed: number;
  notes: string[];
}

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  atsType: string;
  atsToken: string | null;
  tier: string;
  isAgency: boolean;
  active: boolean;
  _count: { postings: number };
}

export interface RunRow {
  id: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  companiesTried: number;
  postingsSeen: number;
  postingsNew: number;
  errors: number;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  /** Null means this account has never been through approval. Combined with
   *  `active`, it distinguishes a pending signup from a suspended account -
   *  both are inactive, and they need opposite actions. */
  approvedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  _count: { applications: number; matchScores: number };
  profiles: { confirmedAt: string | null }[];
}

// --- the resume library -----------------------------------------------------

export type AtomKind = 'BULLET' | 'SKILL' | 'ROLE' | 'EDU';

/** How many pieces of each kind a resume produced. */
export type AtomCounts = Record<AtomKind, number>;

export interface ResumeSummary {
  id: string;
  label: string;
  /** The name the candidate's own file arrived under. Null for resumes ingested
   *  through the CLI before the library existed. */
  filename: string | null;
  isActive: boolean;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  fullName: string;
  email: string;
  counts: AtomCounts;
  atomCount: number;
  techCount: number;
  /** Tailored resumes already generated from this one. Non-zero is why deleting
   *  it asks a second time. */
  variantCount: number;
}

export interface ResumeContact {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
}

/**
 * One piece read out of a resume.
 *
 * `tech` and `metrics` are READ-ONLY here. They are re-derived from the text by
 * the server on every write, because the provenance guard treats them as the
 * complete list of things a tailored rewrite may claim - sending tags up would be
 * a way to license a claim the words do not support.
 */
export interface ParsedAtom {
  kind: AtomKind;
  text: string;
  tech: string[];
  metrics: string[];
  employer?: string | null;
  dateRange?: string | null;

  /**
   * The parts a person types in and a resume file does not state.
   *
   * Never present on a piece that came out of a parse - the server does not guess a
   * CGPA or a salary from a pdf line, deliberately - so all six are absent until the
   * upload form asks for them.
   *
   * `score` and `scoreOutOf` are STRINGS and are saved together or not at all: 8.6
   * has to stay 8.6, and a figure with nothing to compare it to cannot be read. 100
   * means the figure is a percentage.
   */
  /** A project's repository, live site or write-up. */
  link?: string | null;
  /** What a role paid. Stored for the candidate's own reference and never printed
   *  on a resume - the figures an application asks for live in the answers form. */
  ctc?: string | null;
  degree?: string | null;
  fieldOfStudy?: string | null;
  score?: string | null;
  scoreOutOf?: string | null;
}

/** A stored piece: a ParsedAtom that has an id and a place in the order. */
export interface AtomRow extends ParsedAtom {
  id: string;
  ordinal: number;
  /** Null while this piece is waiting for a vector, which is what decides
   *  whether matching can see it. Briefly null right after an edit. */
  embeddedTextHash: string | null;
}

/**
 * The text the server got out of the file, before it split anything up.
 *
 * `chars` is the true length even when `text` was cut short, so the screen can say
 * how much it is not showing.
 */
export interface ExtractedText {
  text: string;
  chars: number;
  truncated: boolean;
}

/**
 * What comes back from the upload step. No database rows have been written - the
 * file itself IS saved, under backend/uploads, which is what `uploadId` names.
 */
export interface UploadResult {
  /** Hand this back with the confirmation, unchanged. */
  uploadId: string;
  filename: string;
  contact: ResumeContact;
  headline: string | null;
  /** Things the parse was unsure about, in plain words. Worth reading before
   *  confirming; not errors. */
  warnings: string[];
  atoms: ParsedAtom[];
  counts: AtomCounts;
  techUnion: string[];
  /** Everything below was derived from this. Shown so a missing bullet can be
   *  told apart from a bullet the parser filed in the wrong place. */
  extracted: ExtractedText;
}

// --- the suggestions list ---------------------------------------------------

/** How far a matching run has got. Not BullMQ's vocabulary - see MatchesService. */
export type RunState = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface MatchRunStatus {
  state: RunState;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Null until a run has finished. The four stages of the funnel, in order. */
  counts: {
    considered: number;
    screened: number;
    ranked: number;
    scored: number;
    failures: number;
  } | null;
  error: string | null;
}

/**
 * How many postings are waiting on a decision, as of now.
 *
 * Counted server-side over the postings worth deciding about - not WEAK or REJECT - so
 * it means the same thing as the digest's own morning count. A page needing this figure
 * must not add up the list instead: that list is capped at 200 rows.
 */
export interface MatchSummary {
  decidable: number;
  undecided: number;
  wanted: number;
  notWanted: number;
}

/** What POST /api/me/matches/run answers. `started: false` means one was already going. */
export interface MatchRunStarted extends MatchRunStatus {
  started: boolean;
}

/**
 * One suggested posting, with enough attached for the row to offer its buttons.
 *
 * `variant` is the tailored resume for this job: null means none has been written,
 * and `guardPassed: false` means one was written and thrown away for claiming
 * something the candidate's resume does not support. Those two are deliberately
 * distinguishable - "not tried" and "refused" would otherwise look the same.
 */
export interface MatchSuggestion {
  jobId: string;
  title: string;
  company: string;
  companyTier: string;
  location: string | null;
  applyUrl: string;
  /**
   * True when this board gets no form filling at all - today that means Workday.
   *
   * Sent by the server, and NOT worked out here from `applyUrl` or from an ATS name:
   * the decision is the host test the submit path itself runs, and a copy of it in the
   * browser would be a second opinion that drifts the day an adapter changes. See
   * appliedByHand in the backend's submission/board.adapters.ts.
   */
  applyByHand: boolean;
  remoteType: string;
  postedAt: string | null;
  score: number;
  verdict: string;
  reasons: string[];
  missingSkills: string[];
  /** A string for the same reason as JobRow.salaryMin - an exact decimal. */
  estimatedSalaryLPA: string | null;
  decision: MatchDecision;
  scoredAt: string;
  variant: {
    id: string;
    guardPassed: boolean;
    hasPdf: boolean;
    createdAt: string;
  } | null;
  application: { id: string; status: string } | null;
}

export interface Integrations {
  editableIn: string;
  items: {
    key: string;
    label: string;
    configured: boolean;
    required: boolean;
    note: string | null;
  }[];
}

// --- the morning digest (phase 7) -------------------------------------------

/** What the candidate can say about a posting from the digest. */
export type MatchDecision = 'UNDECIDED' | 'WANTED' | 'NOT_WANTED';

/**
 * One posting as the digest names it.
 *
 * A SNAPSHOT, not a live row. It is whatever was true when the digest was built,
 * which is why deciding on one of these does not remove it from the list - the
 * page tracks the answer locally instead. A digest that quietly rewrote itself
 * would stop being a record of a morning.
 */
export interface DigestMatch {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  score: number;
  verdict: string;
  /** A string for the same reason as JobRow.salaryMin - it is an exact decimal. */
  salaryLpa: string | null;
  url: string;
}

export interface DigestPayload {
  version: number;
  /** The Indian calendar day this reports on, as YYYY-MM-DD. */
  day: string;
  generatedAt: string;
  /** The start of the window every "since the last digest" number was counted over. */
  since: string;
  candidate: {
    newMatches: number;
    byVerdict: Record<string, number>;
    undecided: number;
    top: DigestMatch[];
    tailored: number;
    guardFailed: number;
    /** Null, not 0, when nothing was tailored. Render it as "n/a". */
    guardFailureRate: number | null;
    preparedWaiting: number;
    submitted: number;
    missingAnswers: string[];
  };
  /** Admins only. Null for a plain candidate. */
  system: {
    newCompanies: number;
    newPostings: number;
    boards: {
      source: string;
      companiesTried: number;
      postingsSeen: number;
      postingsNew: number;
      errors: number;
    }[];
    deadBoards: { source: string; reason: string }[];
    /** Calls by model. Not tokens - token counts are not stored anywhere. */
    modelUse: { model: string; calls: number }[];
    lastDiscoveryAt: string | null;
  } | null;
}

export interface DigestRow {
  id: string;
  day: string;
  /** Null when the stored payload is from a version this build cannot read. */
  payload: DigestPayload | null;
  emailedAt: string | null;
  telegramAt: string | null;
  deliveryError: string | null;
  readAt: string | null;
  createdAt: string;
}

/** What POST /api/me/digest/send reports back. */
export interface DigestSendResult {
  id: string;
  day: string;
  email: 'sent' | 'skipped' | 'failed';
  telegram: 'sent' | 'skipped' | 'failed';
  notes: string[];
}
