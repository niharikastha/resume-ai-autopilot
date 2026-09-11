/**
 * The contract every ATS connector implements.
 *
 * Connectors are PURE: one builds a URL, the other turns a parsed JSON body into
 * postings. Neither touches the network or the database. That split is what makes
 * them testable against a captured payload - the interesting logic in a connector
 * is the field mapping and the salary handling, and none of it should need a live
 * board or a mock `fetch` to exercise.
 *
 * The fetching, retrying and rate limiting all live in DiscoveryHttpClient, and the
 * writing lives in DiscoveryService.
 */
import { AtsType, RemoteType, SalaryPeriod } from '@prisma/client';

/**
 * A salary as an ATS states it.
 *
 * Figures are decimal STRINGS, not numbers, for the same reason the columns are
 * `numeric`: an hourly rate of 12.10 has no exact binary float, and parsing to a
 * number here to stringify it later reintroduces precisely the error the column
 * type was chosen to avoid.
 */
export interface StatedSalary {
  min: string | null;
  max: string | null;
  /** ISO 4217, upper case. */
  currency: string;
  period: SalaryPeriod;
}

/** One posting, as a connector reports it and before anything is derived. */
export interface RawPosting {
  /** Stable per-board identifier. Must be the ATS's own id, never a hash of the
   *  title - see the note in DiscoveryService about why. */
  sourceJobId: string;
  title: string;
  location: string;
  /** The employer's markup, kept verbatim so a parsing change can be re-run
   *  against it without re-fetching every board. */
  descriptionRaw: string;
  /** Plain text, which is what scoring and embedding read. */
  descriptionText: string;
  /** A link to THIS posting. Never a board-level link. */
  applyUrl: string;
  remoteType: RemoteType;
  postedAt: Date | null;
  salary: StatedSalary | null;
  department: string | null;
  employmentType: string | null;
}

export interface Connector {
  /** Connector id, stored in `job_postings.source`. Lower case. */
  readonly source: string;
  readonly atsType: AtsType;

  /**
   * The board's JSON endpoint, including whatever flags return descriptions.
   *
   * `offset` is only meaningful for the paginating sources; the others ignore it
   * and are always called with 0.
   */
  listUrl(token: string, offset?: number): string;

  /**
   * The JSON body to POST to `listUrl`, for a board that takes its query that way.
   *
   * Absent means GET, which is four of the six sources. Workday is the exception: its
   * search endpoint carries the offset and the page size in a POST body, so a
   * connector that could only build a URL could not read a Workday board at all.
   *
   * Still PURE - this returns a value, it does not send anything. The client decides
   * what to do with it.
   */
  listBody?(token: string, offset?: number): unknown;

  /**
   * False when a board cannot be found from a company slug alone.
   *
   * Absent or true means the probe may guess: Greenhouse, Lever, Ashby and Workable
   * all name a board with one lower-case word, so `acme` is a question worth asking.
   * A Workday board is named by THREE parts - the tenant, the data-centre number and
   * the site name, `nvidia` + `wd5` + `NVIDIAExternalCareerSite` - and no two of them
   * are derivable from the company's name. Guessing there is not a long shot, it is
   * arithmetically hopeless, and the cost of trying would be one wasted request
   * against a stranger's host for every company in the list on every sweep.
   *
   * A board like that is added by pasting its URL instead, which states all three.
   */
  readonly guessable?: boolean;

  /**
   * The identifier forms to try when all that is known is a company's slug.
   *
   * Probing guesses `acme` from "Acme Corp" and asks each ATS whether it has a
   * board by that name, which works because Greenhouse, Lever and Ashby tokens are
   * lower case. SmartRecruiters ids are NOT: the board is `BoschGroup`, and
   * `bosch` returns a perfectly well-formed 200 with `totalFound: 0` - so a
   * lower-cased probe records a MISS against a board with 543 India postings on it.
   * That is the exact failure the body-content rule was written to prevent, arriving
   * through the identifier instead of the status code.
   *
   * Omitted means "the slug is the token", which is true of every connector but one.
   * Each extra candidate costs one request per company per sweep, so a connector
   * should return the few forms that are actually plausible, not a combinatorial set.
   */
  tokenCandidates?(slug: string): string[];

  /**
   * The company slug to use when a board URL is all that was pasted.
   *
   * Omitted means the token IS the slug once lower-cased, which is true of five of the
   * six sources - `jobs.lever.co/zeta` names Zeta. A Workday token is three joined
   * fields, so slugifying it whole gives `nvidia-wd5-nvidiaexternalcareersite` and a
   * company called "Nvidia Wd5 Nvidiaexternalcareersite". Only the tenant is the
   * employer's name, and only the connector knows which part that is.
   */
  slugFromToken?(token: string): string;

  /** Maps a parsed response body to postings. Must tolerate missing fields. */
  parse(body: unknown, token: string): RawPosting[];

  /**
   * Total postings the board claims to have, if it says.
   *
   * Present only on sources that paginate. Greenhouse, Lever and Ashby return
   * everything in one response, so for them a single request IS the whole board and
   * pagination would be a loop that always runs once.
   */
  totalAvailable?(body: unknown): number | null;

  /** Postings per page, for the paginating sources. */
  readonly pageSize?: number;

  /**
   * A second request per posting, for sources whose list response omits the
   * description.
   *
   * SmartRecruiters and Workday need this, and it is worth being explicit about the
   * cost: one request per POSTING rather than per board turns a 200-role employer into
   * 200 requests, which at the per-host interval is several minutes for one company -
   * and Workday tenants run to a couple of thousand roles, so an hour. That is
   * affordable for a nightly pass and would not be for anything interactive. A
   * connector that leaves these undefined is fetched once and parsed, which is the
   * cheap path the other four take.
   */
  detailUrl?(posting: RawPosting, token: string): string;

  /** Folds a detail response into the posting from the list response. */
  mergeDetail?(posting: RawPosting, body: unknown): RawPosting;
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

/** Narrows an unknown JSON value to an indexable object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A trimmed string, or null - never the empty string.
 *
 * `optionalText` in the validation schema rejects '' while accepting null, because
 * "not stated" and "stated as nothing" are different facts. Connectors funnel
 * through here so that distinction survives the mapping.
 */
export function asOptionalString(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * A date from whatever an ATS uses: ISO string, epoch milliseconds, or epoch
 * seconds.
 *
 * Lever sends `createdAt: 1787732026874` while Greenhouse sends
 * `"2026-09-02T00:28:11-04:00"`, so the discrimination is necessary rather than
 * defensive. Anything unparseable becomes null - `postedAt` is used for ordering
 * and freshness, and a wrong date is worse there than a missing one.
 */
export function asDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Ten digits is seconds, thirteen is milliseconds. The boundary is ~1973 in
    // ms and ~5138 in seconds, so no real posting date is ambiguous.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    // A posting dated in the far future is a data error, not news. Rejecting it
    // keeps `ORDER BY postedAt DESC` from being permanently topped by junk.
    if (date.getTime() > Date.now() + 366 * 24 * 3600 * 1000) return null;
    return date;
  }
  return null;
}

/**
 * Maps an ATS's pay interval onto SalaryPeriod.
 *
 * Returns null for anything not representable, and WEEK is the reason this
 * function returns null rather than guessing. Ashby really does send `"1 WEEK"`,
 * and SalaryPeriod has no WEEK member - so a weekly figure either gets dropped or
 * gets mislabelled. Dropped is correct: a weekly rate stored as MONTH understates
 * the pay by more than four times, and an understated salary is how a good job gets
 * filtered out of the pool and never seen.
 */
export function toSalaryPeriod(raw: unknown): SalaryPeriod | null {
  const value = asString(raw).toUpperCase();
  if (!value) return null;
  // Substring tests, because the same idea arrives as 'YEAR', 'YEARLY', 'ANNUAL',
  // '1 YEAR' and 'per-year-salary' depending on the vendor.
  if (/ANNUM|ANNUAL|YEAR/.test(value)) return SalaryPeriod.YEAR;
  if (/MONTH/.test(value)) return SalaryPeriod.MONTH;
  if (/\bDAY|DAILY/.test(value)) return SalaryPeriod.DAY;
  if (/HOUR/.test(value)) return SalaryPeriod.HOUR;
  return null;
}

/**
 * A money figure as a 2-decimal string, or null.
 *
 * Bounded by what `numeric(14,2)` holds. A figure over the cap is dropped rather
 * than clamped: clamping would invent a salary, and the CHECK constraint would
 * reject the row anyway - so the choice is between losing one field and losing the
 * whole posting.
 */
export function toMoney(value: unknown): string | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.replace(/[,\s]/g, ''))
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 99_999_999_999.99) return null;
  return n.toFixed(2);
}

/**
 * Assembles a StatedSalary, or null if it would not be a usable one.
 *
 * Every rule the database enforces is applied here, so a connector cannot produce a
 * salary that fails a CHECK constraint:
 *  - a figure is required (STATED with no number is refused by the schema)
 *  - a currency and a period are required, or the number means nothing
 *  - min must not exceed max
 */
export function makeSalary(
  min: unknown,
  max: unknown,
  currency: unknown,
  period: unknown,
): StatedSalary | null {
  const lo = toMoney(min);
  const hi = toMoney(max);
  if (lo === null && hi === null) return null;

  const code = asString(currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;

  const p = toSalaryPeriod(period);
  if (p === null) return null;

  // An inverted range means the source is confused about its own fields, so the
  // safe reading is that neither bound is trustworthy - not that they should be
  // swapped into looking plausible.
  if (lo !== null && hi !== null && Number(hi) < Number(lo)) return null;

  return { min: lo, max: hi, currency: code, period: p };
}
