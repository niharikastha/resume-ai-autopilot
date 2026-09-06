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
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
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
