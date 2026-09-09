/**
 * The numeric and shape bounds every domain value must satisfy.
 *
 * These exist in TWO places by necessity: as CHECK constraints in
 * prisma/migrations/20260906120000_integrity_constraints/migration.sql, and as
 * the Zod schemas in domain.schema.ts. Neither can be derived from the other -
 * Prisma cannot express a CHECK, and Postgres cannot produce a 400 with a helpful
 * message - so the database gets the last word and the service gets the good
 * error.
 *
 * What it must not become is two sets of numbers that quietly disagree. Hence
 * this file: one definition, imported by the Zod schemas, and cross-checked
 * against the migration SQL by domain.constants.spec.ts. Change a bound here and
 * that test tells you which constraint to update.
 *
 * Same discipline as auth-retention.ts, for the same reason.
 */

/** MatchScore.score. 0-100, inclusive. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/**
 * Anything expressing "how sure are we" as a fraction:
 * JobPosting.salaryConfidence, MatchScore.salaryConfidence,
 * Application.prefillCoverage.
 *
 * A fraction, NOT a percentage. The 0-1 bound is what stops the two conventions
 * being mixed - a coverage of 85 meaning 85% would otherwise be stored happily
 * and then read as 8500%.
 */
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 1;

/**
 * Lakhs per annum, for CTC and salary estimates.
 *
 * The upper bound is a typo guard rather than a salary cap: it catches 1200000
 * entered by someone who meant 12. Decimal(6,2) is the column, so 9999.99 is the
 * hard ceiling; 1000 is the useful one.
 */
export const LPA_MIN = 0;
export const LPA_MAX = 1000;

/** Two decimal places, matching Decimal(6,2) and Decimal(14,2). */
export const MONEY_DECIMAL_PLACES = 2;

/** Absolute salary figures on a posting. Decimal(14,2). */
export const SALARY_MIN = 0;
export const SALARY_MAX = 99_999_999_999.99;

/** ApplicationAnswers.noticePeriodDays. A year is a generous ceiling. */
export const NOTICE_PERIOD_DAYS_MIN = 0;
export const NOTICE_PERIOD_DAYS_MAX = 365;

/**
 * ApplicationAnswers.customAnswers - how many saved screening questions one
 * candidate may keep.
 *
 * A cap rather than no cap because this is free text stored forever in a JSON
 * column, and the filler scans every entry for each field it meets. 50 is far past
 * what the recurring questions actually amount to: sponsorship, notice, relocation,
 * why-this-company and a handful of board-specific ones.
 */
export const CUSTOM_ANSWERS_MAX = 50;

/** JobPosting.yoeMin / yoeMax. */
export const YOE_MIN = 0;
export const YOE_MAX = 60;

/** CompanyProbe.httpStatus. The valid HTTP status range. */
export const HTTP_STATUS_MIN = 100;
export const HTTP_STATUS_MAX = 599;

/** ProfileAtom.ordinal. */
export const ORDINAL_MIN = 0;

/** ISO 4217: three upper-case letters. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * JobPosting.applyUrl. http(s) only - a `javascript:` or `data:` URL reaching a
 * browser the form filler drives would be a code path nobody intended.
 */
export const APPLY_URL_PATTERN = /^https?:\/\//;

/** Free-text length ceilings, so an unbounded field cannot be used to bloat a row. */
export const TEXT_SHORT_MAX = 200;
export const TEXT_MEDIUM_MAX = 2_000;
export const TEXT_LONG_MAX = 20_000;
