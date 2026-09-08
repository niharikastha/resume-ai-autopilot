/**
 * The shape of one morning's report.
 *
 * A ZOD SCHEMA RATHER THAN AN INTERFACE, because this travels through a Json
 * column. `DailyDigest.payload` is `Prisma.JsonValue` on the way out, which means the
 * compiler knows nothing about it - and the rows are written by a version of this file
 * that may be older than the one reading them. A digest from last week whose shape has
 * since changed must render as "this digest is from an older version" rather than as a
 * page of `undefined`, and that is only possible if the read is validated.
 *
 * Same reasoning as the LLM boundary: anything crossing into this process from
 * somewhere the type system does not reach gets parsed, not cast.
 *
 * WHAT IS IN HERE IS DECIDED BY PLAN-v2 PHASE 7: applications prepared, awaiting
 * review, guard failure rate, dead connectors, token spend, plus the two v2 additions -
 * new companies discovered and per-board yield.
 */
import { z } from 'zod';

/** How many postings the digest names individually. */
export const TOP_MATCHES = 8;

/**
 * One posting, as it appears in the digest.
 *
 * Enough to decide from a phone and nothing more. No description, no reasons list:
 * this is the thing that has to be readable on a lock screen, and the decision it asks
 * for ("do you want this one?") is answerable from the title, the employer and the
 * score.
 */
export const DigestMatchSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  score: z.number().int(),
  verdict: z.string(),
  /** Estimated more often than stated - see SalarySource. A string, not a float. */
  salaryLpa: z.string().nullable(),
  url: z.string(),
});

/** One board's day. The per-board yield PLAN-v2 adds to the digest. */
export const DigestBoardSchema = z.object({
  source: z.string(),
  companiesTried: z.number().int(),
  postingsSeen: z.number().int(),
  postingsNew: z.number().int(),
  errors: z.number().int(),
});

/**
 * A connector that is not working, with the reason it is being called that.
 *
 * The reason travels with it because "dead" is a judgement, not a measurement: a board
 * that returned nothing may be broken or may simply have had no new postings today,
 * and the person reading the digest is the one who can tell.
 */
export const DigestDeadBoardSchema = z.object({
  source: z.string(),
  reason: z.string(),
});

/** LLM calls that left a trace in the database, grouped by model. */
export const DigestModelUseSchema = z.object({
  model: z.string(),
  calls: z.number().int(),
});

/** The candidate's own morning. Present in every digest. */
export const DigestCandidateSchema = z.object({
  /** Scored since the last digest. The headline number. */
  newMatches: z.number().int(),
  byVerdict: z.record(z.string(), z.number().int()),
  /** Everything still waiting for a yes or no, not only today's. */
  undecided: z.number().int(),
  top: z.array(DigestMatchSchema),

  /** Resumes written since the last digest, and how many the guard rejected. */
  tailored: z.number().int(),
  guardFailed: z.number().int(),
  /**
   * Null when nothing was tailored, NOT zero. Zero out of zero is not a 0% failure
   * rate - it is no information, and a run of quiet days would otherwise read as a
   * perfect record.
   */
  guardFailureRate: z.number().nullable(),

  /** Forms filled and waiting for the candidate to submit them. */
  preparedWaiting: z.number().int(),
  submitted: z.number().int(),

  /**
   * Answers the form filler needs and does not have, named in plain words.
   *
   * In the digest because this is the one item on it that the candidate can fix in two
   * minutes, and because its cost is invisible otherwise: a missing expected-CTC does
   * not fail anything, it just leaves a required box empty on every form.
   */
  missingAnswers: z.array(z.string()),
});

/**
 * The machine's morning. ADMINS ONLY.
 *
 * Null for a plain candidate, and null rather than absent so that "this digest had no
 * system section" is distinguishable from "this digest is from a version that had no
 * system section at all". Board yield and connector health are facts about the
 * operator's machine, not about anybody's job search.
 */
export const DigestSystemSchema = z.object({
  newCompanies: z.number().int(),
  newPostings: z.number().int(),
  boards: z.array(DigestBoardSchema),
  deadBoards: z.array(DigestDeadBoardSchema),
  /**
   * PLAN asks the digest to report token spend. Token counts are not persisted
   * anywhere - the provider logs them per call and they are gone - so what this
   * reports is CALLS BY MODEL, counted from the rows those calls produced.
   *
   * Named `modelUse` and not `tokenSpend` for that reason. Reporting a number of
   * tokens that was in fact a number of calls would be worse than reporting neither.
   */
  modelUse: z.array(DigestModelUseSchema),
  lastDiscoveryAt: z.string().nullable(),
});

export const DigestPayloadSchema = z.object({
  /**
   * Bumped when a field is removed or changes meaning; adding an optional field does
   * not need it. The reader checks this before trusting the rest.
   */
  version: z.literal(1),
  /** The IST calendar day this reports on, as YYYY-MM-DD. */
  day: z.string(),
  generatedAt: z.string(),
  /** The window the "new since" numbers were counted over. */
  since: z.string(),
  candidate: DigestCandidateSchema,
  system: DigestSystemSchema.nullable(),
});

export type DigestMatch = z.infer<typeof DigestMatchSchema>;
export type DigestBoard = z.infer<typeof DigestBoardSchema>;
export type DigestCandidate = z.infer<typeof DigestCandidateSchema>;
export type DigestSystem = z.infer<typeof DigestSystemSchema>;
export type DigestPayload = z.infer<typeof DigestPayloadSchema>;

/**
 * A stored payload, or null if it is not one this version understands.
 *
 * Returns null rather than throwing. A digest row that cannot be read is a rendering
 * problem for one card in a list, and it must not take down the request that was
 * fetching a week of them.
 */
export function readPayload(value: unknown): DigestPayload | null {
  const parsed = DigestPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
