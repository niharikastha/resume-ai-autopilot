/**
 * Service-layer validation for the domain tables, mirroring the CHECK constraints
 * added in migration 20260906120000_integrity_constraints.
 *
 * WHY BOTH. The database constraint is the guarantee - it holds no matter which
 * service, CLI command or psql session does the writing, and it cannot be
 * forgotten. But a constraint violation surfaces as a Postgres error naming a
 * constraint, which is the wrong thing to put in front of a user and the wrong
 * status code to return. These schemas catch the same mistakes one layer earlier
 * and say which field was wrong and why.
 *
 * So: Zod for the message, Postgres for the guarantee. Neither is redundant, and
 * the bounds they share live in domain.constants.ts precisely once.
 *
 * Zod rather than class-validator, matching the existing boundaries - see the note
 * in main.ts about not running two validation stacks.
 */
import { z } from 'zod';
import {
  APPLY_URL_PATTERN,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  CURRENCY_PATTERN,
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  LPA_MAX,
  LPA_MIN,
  MONEY_DECIMAL_PLACES,
  NOTICE_PERIOD_DAYS_MAX,
  NOTICE_PERIOD_DAYS_MIN,
  ORDINAL_MIN,
  SALARY_MAX,
  SALARY_MIN,
  SCORE_MAX,
  SCORE_MIN,
  TEXT_LONG_MAX,
  TEXT_MEDIUM_MAX,
  TEXT_SHORT_MAX,
  YOE_MAX,
  YOE_MIN,
} from './domain.constants';

// ---------------------------------------------------------------------------
// FIELD SCHEMAS
// ---------------------------------------------------------------------------

/**
 * Non-empty after trimming, and trimmed on the way through.
 *
 * The trim is the point. `length(trim(x)) > 0` in the database rejects '   ', so
 * a schema that only checked `.min(1)` would pass a string the database then
 * refuses - the two layers disagreeing on the same rule, which is the failure mode
 * this whole module exists to avoid.
 */
export const requiredText = (max = TEXT_SHORT_MAX) =>
  z.string().trim().min(1).max(max);

/** Optional text that must be non-empty IF present - null and '' are not the same. */
export const optionalText = (max = TEXT_SHORT_MAX) =>
  requiredText(max).nullish();

/**
 * A money value, carried as a STRING rather than a number.
 *
 * The columns are `numeric`, and the reason they are numeric is that a binary
 * float cannot hold 12.1. Parsing to a JS number here would reintroduce exactly
 * the error the column type was changed to avoid, so the value stays decimal all
 * the way to Prisma - which accepts a string for a Decimal field.
 *
 * The range comparison below goes through Number, which is safe: these bounds are
 * far below 2^53, so the comparison is exact even though the arithmetic would not
 * be.
 */
const decimalString = (min: number, max: number, label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
    .refine((s) => /^-?\d+(\.\d+)?$/.test(s), `${label} must be a number`)
    .refine(
      (s) => (s.split('.')[1]?.length ?? 0) <= MONEY_DECIMAL_PLACES,
      `${label} may have at most ${MONEY_DECIMAL_PLACES} decimal places`,
    )
    .refine(
      (s) => Number(s) >= min && Number(s) <= max,
      `${label} must be between ${min} and ${max}`,
    );

/** Lakhs per annum. Matches Decimal(6,2) and the LPA range checks. */
export const lpaField = decimalString(LPA_MIN, LPA_MAX, 'Amount in LPA');

/** An absolute salary figure on a posting. Matches Decimal(14,2). */
export const salaryField = decimalString(SALARY_MIN, SALARY_MAX, 'Salary');

/** 0-100 integer. */
export const scoreField = z.number().int().min(SCORE_MIN).max(SCORE_MAX);

/**
 * A 0-1 fraction. `.max(1)` is doing real work here: percentages and fractions
 * are the classic silent mix-up, and 85 for "85%" is caught at the boundary
 * instead of being stored.
 */
export const confidenceField = z
  .number()
  .min(CONFIDENCE_MIN)
  .max(CONFIDENCE_MAX);

export const yoeField = z.number().int().min(YOE_MIN).max(YOE_MAX);

export const noticePeriodField = z
  .number()
  .int()
  .min(NOTICE_PERIOD_DAYS_MIN)
  .max(NOTICE_PERIOD_DAYS_MAX);

export const httpStatusField = z
  .number()
  .int()
  .min(HTTP_STATUS_MIN)
  .max(HTTP_STATUS_MAX);

export const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(CURRENCY_PATTERN, 'Must be a 3-letter ISO 4217 code, e.g. INR');

export const applyUrlField = z
  .string()
  .trim()
  .max(TEXT_MEDIUM_MAX)
  .regex(APPLY_URL_PATTERN, 'Must be an http(s) URL');

export const ordinalField = z.number().int().min(ORDINAL_MIN);

/** Deliberately loose, for the same reason as the auth controller's: local
 *  accounts are addressed as name@localhost, which strict validation rejects. */
export const emailField = z
  .string()
  .trim()
  .min(3)
  .max(TEXT_SHORT_MAX)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Must look like an email address');

// ---------------------------------------------------------------------------
// OBJECT SCHEMAS
// ---------------------------------------------------------------------------

/**
 * What a candidate may write to their own answers.
 *
 * There is no gender, race, disability or veteran field here, and there is no
 * column for one either. Those questions are never stored, never inferred and
 * never auto-filled. An admin cannot write this object at all - see the model
 * doc on ApplicationAnswers.
 */
export const applicationAnswersInput = z.object({
  workAuthorization: optionalText(TEXT_MEDIUM_MAX),
  needsSponsorship: z.boolean().nullish(),
  noticePeriodDays: noticePeriodField.nullish(),
  currentCtcLpa: lpaField.nullish(),
  expectedCtcLpa: lpaField.nullish(),
  willingToRelocate: z.boolean().nullish(),
  earliestStartDate: z.coerce.date().nullish(),
  customAnswers: z.record(z.string(), z.string()).nullish(),
});

export const profileAtomInput = z.object({
  kind: z.enum(['BULLET', 'SKILL', 'ROLE', 'EDU']),
  text: requiredText(TEXT_MEDIUM_MAX),
  tech: z.array(requiredText(TEXT_SHORT_MAX)).default([]),
  metrics: z.array(requiredText(TEXT_SHORT_MAX)).default([]),
  employer: optionalText(),
  dateRange: optionalText(),
  ordinal: ordinalField,
});

export const candidateProfileInput = z.object({
  label: requiredText(),
  fullName: requiredText(),
  email: emailField,
  phone: optionalText(),
  location: optionalText(),
  linkedIn: optionalText(TEXT_MEDIUM_MAX),
  github: optionalText(TEXT_MEDIUM_MAX),
  portfolio: optionalText(TEXT_MEDIUM_MAX),
  /**
   * Ordinals must be unique within a profile - `@@unique([profileId, ordinal])`.
   * Checked here because the database would report it as a constraint violation
   * on whichever row happened to be inserted second, which does not tell the
   * caller that they sent two atoms numbered 3.
   */
  atoms: z.array(profileAtomInput).superRefine((atoms, ctx) => {
    const seen = new Set<number>();
    for (const [i, atom] of atoms.entries()) {
      if (seen.has(atom.ordinal)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'ordinal'],
          message: `Duplicate ordinal ${atom.ordinal}`,
        });
      }
      seen.add(atom.ordinal);
    }
  }),
});

/**
 * A posting as a connector produces it.
 *
 * The two refinements below are the ordering rules: a range whose max is below its
 * min is not a range, and STATED without a figure is a label the row cannot
 * support.
 */
export const jobPostingInput = z
  .object({
    source: requiredText(),
    sourceJobId: requiredText(),
    title: requiredText(TEXT_MEDIUM_MAX),
    normalizedTitle: requiredText(TEXT_MEDIUM_MAX),
    descriptionRaw: z.string().max(TEXT_LONG_MAX * 10),
    descriptionText: z.string().max(TEXT_LONG_MAX * 10),
    location: optionalText(),
    remoteType: z
      .enum([
        'ONSITE',
        'HYBRID',
        'REMOTE_INDIA',
        'REMOTE_GLOBAL',
        'REMOTE_OTHER_REGION',
        'UNKNOWN',
      ])
      .default('UNKNOWN'),
    seniority: optionalText(),
    yoeMin: yoeField.nullish(),
    yoeMax: yoeField.nullish(),
    salaryMin: salaryField.nullish(),
    salaryMax: salaryField.nullish(),
    salaryCurrency: currencyField.nullish(),
    salaryPeriod: z.enum(['YEAR', 'MONTH', 'DAY', 'HOUR']).nullish(),
    salarySource: z.enum(['STATED', 'ESTIMATED', 'UNKNOWN']).default('UNKNOWN'),
    salaryConfidence: confidenceField.nullish(),
    applyUrl: applyUrlField,
    contentHash: requiredText(),
    postedAt: z.coerce.date().nullish(),
  })
  .superRefine((v, ctx) => {
    if (
      v.yoeMin != null &&
      v.yoeMax != null &&
      Number(v.yoeMax) < Number(v.yoeMin)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['yoeMax'],
        message: 'Maximum years of experience is below the minimum',
      });
    }
    if (
      v.salaryMin != null &&
      v.salaryMax != null &&
      Number(v.salaryMax) < Number(v.salaryMin)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['salaryMax'],
        message: 'Maximum salary is below the minimum',
      });
    }
    if (
      v.salarySource === 'STATED' &&
      v.salaryMin == null &&
      v.salaryMax == null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['salarySource'],
        message: 'STATED requires a salary figure - use ESTIMATED or UNKNOWN',
      });
    }
  });

export const matchScoreInput = z.object({
  score: scoreField,
  verdict: z.enum(['STRONG', 'GOOD', 'BORDERLINE', 'WEAK', 'REJECT']),
  reasons: z.array(requiredText(TEXT_MEDIUM_MAX)).default([]),
  missingSkills: z.array(requiredText()).default([]),
  estimatedSalaryLPA: lpaField.nullish(),
  salaryConfidence: confidenceField.nullish(),
  llmProvider: requiredText(),
  model: requiredText(),
  vectorDistance: z.number().min(0).nullish(),
});

export const sourceRunResultInput = z
  .object({
    companiesTried: z.number().int().min(0),
    postingsSeen: z.number().int().min(0),
    postingsNew: z.number().int().min(0),
    errors: z.number().int().min(0),
  })
  .refine((v) => v.postingsNew <= v.postingsSeen, {
    path: ['postingsNew'],
    message: 'New postings cannot exceed postings seen',
  });

export const companyProbeInput = z.object({
  slugTried: requiredText(),
  atsType: z.enum([
    'GREENHOUSE',
    'LEVER',
    'ASHBY',
    'SMARTRECRUITERS',
    'WORKABLE',
    'WORKDAY',
    'CUSTOM',
    'UNKNOWN',
  ]),
  result: z.enum(['HIT', 'MISS', 'TENANT_NOT_FOUND', 'FORBIDDEN', 'ERROR']),
  httpStatus: httpStatusField.nullish(),
  jobsFound: z.number().int().min(0).nullish(),
  notes: optionalText(TEXT_MEDIUM_MAX),
});

/**
 * An application write, carrying the three cross-field rules the CHECK constraints
 * enforce.
 *
 * The SUBMITTED rule is the load-bearing one: PLAN-v2 says an application is
 * recorded as submitted only on a DETECTED confirmation, never optimistically.
 * That is now checked here AND in the database, so it holds even if some future
 * caller forgets it.
 */
export const applicationWriteInput = z
  .object({
    status: z.enum([
      'QUEUED',
      'AWAITING_REVIEW',
      'APPROVED',
      'REJECTED',
      'PREPARED',
      'SUBMITTED',
      'FAILED',
      'SKIPPED',
    ]),
    normalizedTitle: requiredText(TEXT_MEDIUM_MAX),
    resumeVariantId: z.string().uuid().nullish(),
    coverLetter: z.string().max(TEXT_LONG_MAX).nullish(),
    screeningAnswers: z.record(z.string(), z.string()).nullish(),
    prefillCoverage: confidenceField.nullish(),
    submittedAt: z.coerce.date().nullish(),
    confirmationText: optionalText(TEXT_MEDIUM_MAX),
    failureReason: optionalText(TEXT_MEDIUM_MAX),
  })
  .superRefine((v, ctx) => {
    if (v.resumeVariantId != null && v.coverLetter != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['coverLetter'],
        message:
          'A variant already holds the cover letter - this field is only for applications without one',
      });
    }
    if (
      v.status === 'SUBMITTED' &&
      (v.submittedAt == null || !v.confirmationText)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          'SUBMITTED requires submittedAt and a detected confirmation - never record it optimistically',
      });
    }
    if (v.status === 'FAILED' && !v.failureReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['failureReason'],
        message: 'FAILED requires a reason',
      });
    }
  });
