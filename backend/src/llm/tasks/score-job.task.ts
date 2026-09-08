/**
 * Stage 3 of the matching funnel: score one job description against one profile.
 *
 * PLAN-v2 phase 4 stage 3, defined here rather than in the matching module because
 * a task IS its prompt plus its schema and both providers must use exactly this
 * one. The funnel calls it; it does not own it.
 *
 * WHY THE PROFILE IS `shared` AND THE JOB IS `input`: a scoring run sends the same
 * candidate against every posting that survived stages 1 and 2. The profile is the
 * expensive half of the prompt - twenty atoms of resume text plus the rubric - and
 * it is byte-identical across the whole run, so it goes in the cached prefix and is
 * paid for once. The job description is the cheap half and varies, so it is the
 * user turn. Getting this backwards costs roughly 10x on a 200-posting day and
 * produces no error.
 *
 * WHAT THIS TASK IS NOT ALLOWED TO DO: it does not rewrite anything, it does not
 * see the candidate's name, and its salary estimate cannot reject a posting on its
 * own (PLAN-v2 change 2 - with structured pay data on 0.3% of Indian postings there
 * is nothing to calibrate an estimate against, so it is a tie-breaker only). The
 * estimate is collected anyway because it is shown to the candidate as a figure to
 * negotiate against, which is a different job from gating.
 */
import { z } from 'zod';
import { LlmTask } from '../llm.types';

/**
 * The scoring rubric.
 *
 * In the cached prefix rather than in `instruction` because it is tuned against
 * measured data (PLAN-v2 phase 4: "thresholds are tuned against phase 1's measured
 * data") and a tuning change should not require editing the code that sends it.
 * Kept as a constant string rather than assembled from the targets file: the
 * verdict bands must mean the same thing across runs for scores to be comparable,
 * and a rubric that quietly follows a YAML edit makes yesterday's 78 and today's 78
 * different numbers.
 */
const RUBRIC = `Verdict bands, applied to the score:
  STRONG      85-100  clearly worth applying to today
  GOOD        70-84   worth applying to
  BORDERLINE  50-69   a real stretch in one direction or a poor fit in one area
  WEAK        30-49   several material gaps
  REJECT      0-29    wrong role, wrong discipline, or requires far more experience

Weigh, in this order:
  1. Does the day-to-day work of this role match what the candidate has actually
     built? A title match with unrelated work is not a match.
  2. Required years of experience against the candidate's. A role asking for
     double is a REJECT however good the skills overlap.
  3. Overlap on the technologies the posting treats as required, not the ones in
     its "nice to have" list.
  4. Whether the gaps are learnable in the first month or are the job itself.

A posting that is vague about its requirements is not therefore a good match.
Score what it says, and say in the reasons that it says little.`;

/** What the candidate looks like to this task. */
export interface ScoreJobShared {
  /** Years of professional experience, as the targets file states them. */
  candidateYears: number;
  /** Headline, if the resume had one. */
  headline: string | null;
  /** The atoms, verbatim. No rewriting at this stage. */
  atoms: { kind: string; text: string; tech: string[]; employer?: string | null }[];
  /** Union of every tech tag on the profile, deduplicated and sorted. */
  tech: string[];
}

/** One posting to score. */
export interface ScoreJobInput {
  title: string;
  company: string;
  location: string | null;
  /** The description. Plain text, already extracted from HTML by discovery. */
  description: string;
  /** Whatever the board stated, if anything. Usually nothing, in India. */
  statedSalary?: string | null;
}

export const MatchVerdictSchema = z.enum([
  'STRONG',
  'GOOD',
  'BORDERLINE',
  'WEAK',
  'REJECT',
]);

/**
 * The output schema, which is also the only definition of the output type.
 *
 * Every field is required. An optional field in a structured-output schema is an
 * invitation for the model to omit the one that was inconvenient, and a missing
 * `missingSkills` is indistinguishable from "no missing skills" once it is a row.
 * Nullable is used instead where absence is a real answer.
 */
export const ScoreJobOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: MatchVerdictSchema,

  /**
   * Why, in the model's words, for the digest and for tuning.
   *
   * Capped because these are read by a human every morning; an essay per posting
   * is not read at all, which is worse than three lines that are.
   */
  reasons: z.array(z.string().min(1).max(300)).min(1).max(5),

  /** Required things the profile does not evidence. Empty array is a real answer. */
  missingSkills: z.array(z.string().min(1).max(60)).max(12),

  /**
   * Lakhs per annum, or null when there is genuinely nothing to base it on.
   *
   * Nullable ON PURPOSE, and the prompt says so: a model pushed to produce a
   * number always produces one, and an invented figure with a confidence attached
   * looks exactly like a researched one.
   */
  estimatedSalaryLPA: z.number().min(0).max(500).nullable(),

  /** 0-1. Must be low when the estimate is a guess from the tier alone. */
  salaryConfidence: z.number().min(0).max(1),
});

export type ScoreJobOutput = z.infer<typeof ScoreJobOutputSchema>;

export const scoreJobTask: LlmTask<
  ScoreJobShared,
  ScoreJobInput,
  ScoreJobOutput
> = {
  name: 'score-job',
  tier: 'fast',
  // Bounded output - five reasons and a handful of numbers. Generous anyway,
  // because a response truncated mid-JSON fails the schema and costs a retry.
  maxTokens: 2048,
  schema: ScoreJobOutputSchema,

  instruction:
    'You score job postings against one candidate profile for a job search in ' +
    'India. You are given the candidate first, then one posting. Judge only the ' +
    'fit between them.\n\n' +
    'Rules:\n' +
    '- The profile below is the complete record of what the candidate has done. ' +
    'Do not assume unlisted experience, and do not credit a technology that ' +
    'appears only in the posting.\n' +
    '- Salary: estimate in LPA (lakhs per annum) ONLY if the posting states a ' +
    'range or the role and market make a narrow range obvious. Otherwise return ' +
    'null with a low confidence. A guess presented as an estimate is worse than ' +
    'no estimate, because it will be shown to the candidate as a number to ' +
    'negotiate against.\n' +
    '- Be blunt in the reasons. This output is read by the candidate every ' +
    'morning to decide where to spend a limited number of applications.\n' +
    // These are the schema's own limits, restated for the model. They are not
    // decoration: nothing enforces a maxLength or a maxItems during generation on
    // either provider (both drop those keywords - see jsonSchemaOf), so a limit the
    // prompt does not state is a limit that gets broken and costs the whole posting
    // its score. Measured: unstated, roughly half of a real run failed here, and
    // every failure was a length or a count, never a wrong verdict or a bad number.
    '- At most FIVE reasons, each one sentence and under 300 characters. They are ' +
    'read as a list, so a sixth reason or a paragraph is worse than four sharp ' +
    'ones - if you have more to say, say the most decisive part.\n' +
    '- missingSkills holds NAMES, not explanations: "Apache Spark", not "Apache ' +
    'Spark (required, deep runtime internals expertise)". Under 60 characters ' +
    'each, at most twelve, and the reasons are where the explaining goes.',

  /**
   * The cached half. A pure function of `shared` - no dates, no counters, no
   * iteration over an unordered map. `tech` arrives pre-sorted for that reason.
   */
  prefix(shared) {
    const atoms = shared.atoms
      .map(
        (a, i) =>
          `[${i + 1}] (${a.kind})${a.employer ? ` @${a.employer}` : ''} ${a.text}` +
          (a.tech.length > 0 ? `\n     tech: ${a.tech.join(', ')}` : ''),
      )
      .join('\n');

    return [
      RUBRIC,
      '',
      '--- CANDIDATE ---',
      `Years of professional experience: ${shared.candidateYears}`,
      shared.headline ? `Headline: ${shared.headline}` : 'Headline: (none)',
      `Technologies evidenced anywhere on the profile: ${shared.tech.join(', ')}`,
      '',
      'Profile atoms (verbatim from the resume):',
      atoms,
    ].join('\n');
  },

  question(input) {
    return [
      '--- POSTING ---',
      `Title: ${input.title}`,
      `Company: ${input.company}`,
      `Location: ${input.location ?? '(not stated)'}`,
      input.statedSalary
        ? `Stated compensation: ${input.statedSalary}`
        : 'Stated compensation: (none stated)',
      '',
      'Description:',
      input.description,
    ].join('\n');
  },
};
