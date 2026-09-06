/**
 * Keeps the TypeScript bounds and the SQL CHECK constraints from drifting apart.
 *
 * The bounds have to exist twice - Prisma cannot express a CHECK, and Postgres
 * cannot return a useful 400 - so the risk is not that one layer is missing, it is
 * that someone widens a bound in domain.constants.ts, sees the API accept the new
 * value, and never learns that the database still rejects it. That failure shows up
 * in production as a 500 on a value the form said was fine.
 *
 * So this test reads the migration SQL as text and asserts every bound it can see
 * matches the constant. No database needed, so it runs in CI.
 *
 * If it fails, the fix is almost never to change the assertion: it is to write a
 * NEW migration altering the constraint, because the old one is already applied to
 * a real database and editing an applied migration file changes nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  APPLY_URL_PATTERN,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  CURRENCY_PATTERN,
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  LPA_MAX,
  LPA_MIN,
  NOTICE_PERIOD_DAYS_MAX,
  NOTICE_PERIOD_DAYS_MIN,
  ORDINAL_MIN,
  SCORE_MAX,
  SCORE_MIN,
  YOE_MAX,
  YOE_MIN,
} from './domain.constants';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260906120000_integrity_constraints/migration.sql',
);

const sql = readFileSync(MIGRATION, 'utf8');

/**
 * The body of one named CHECK constraint.
 *
 * Balanced-paren scan rather than a regex, because these expressions contain
 * nested parentheses and a greedy or lazy regex would either stop at the first
 * inner `)` or run into the following constraint - and running on would make the
 * assertions below pass for the wrong reason, which is worse than failing.
 */
function checkBody(name: string): string {
  // `\s*` because the longer constraints wrap between the name and CHECK. Matching
  // on the literal `" CHECK (` found only the one-liners, which meant the
  // assertions below quietly skipped most of the file.
  const found = new RegExp(`"${name}"\\s*CHECK\\s*\\(`).exec(sql);
  if (!found) {
    throw new Error(
      `no CHECK constraint named "${name}" in the migration. If it was renamed, ` +
        'update this test; if it was dropped, the matching constant should go too.',
    );
  }
  let i = found.index + found[0].length - 1;
  let depth = 0;
  const start = i;
  for (; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses in constraint "${name}"`);
}

/** Every numeric literal in an expression, in order of appearance. */
function numbersIn(expr: string): number[] {
  return (expr.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

describe('domain constants match the SQL CHECK constraints', () => {
  /**
   * Each entry: the constraint, and the constants that MUST appear as literals in
   * it. Order-independent - the assertion is about which bounds are present, not
   * how the expression is written, so reformatting the SQL does not break this.
   */
  const cases: Array<[name: string, expected: number[]]> = [
    ['match_scores_score_range_check', [SCORE_MIN, SCORE_MAX]],
    [
      'match_scores_salary_confidence_range_check',
      [CONFIDENCE_MIN, CONFIDENCE_MAX],
    ],
    ['match_scores_estimated_salary_range_check', [LPA_MIN, LPA_MAX]],
    [
      'job_postings_salary_confidence_range_check',
      [CONFIDENCE_MIN, CONFIDENCE_MAX],
    ],
    ['job_postings_yoe_nonneg_check', [YOE_MIN, YOE_MAX]],
    [
      'applications_prefill_coverage_range_check',
      [CONFIDENCE_MIN, CONFIDENCE_MAX],
    ],
    [
      'application_answers_notice_range_check',
      [NOTICE_PERIOD_DAYS_MIN, NOTICE_PERIOD_DAYS_MAX],
    ],
    ['application_answers_current_ctc_range_check', [LPA_MIN, LPA_MAX]],
    ['application_answers_expected_ctc_range_check', [LPA_MIN, LPA_MAX]],
    [
      'company_probes_http_status_range_check',
      [HTTP_STATUS_MIN, HTTP_STATUS_MAX],
    ],
    ['profile_atoms_ordinal_nonneg_check', [ORDINAL_MIN]],
  ];

  it.each(cases)('%s uses the shared bounds', (name, expected) => {
    const literals = numbersIn(checkBody(name));
    for (const bound of expected) {
      expect(literals).toContain(bound);
    }
  });

  it('embeds the currency pattern verbatim', () => {
    expect(checkBody('job_postings_currency_shape_check')).toContain(
      CURRENCY_PATTERN.source,
    );
  });

  it('embeds the apply-url pattern', () => {
    // The JS source escapes the slashes (`\/\/`); SQL does not. Comparing the
    // unescaped form is what makes this an assertion about the RULE rather than
    // about JavaScript's regex-literal syntax.
    const unescaped = APPLY_URL_PATTERN.source.replace(/\\\//g, '/');
    expect(checkBody('job_postings_apply_url_shape_check')).toContain(
      unescaped,
    );
  });

  /**
   * The invariants with no numbers in them. Asserted by name only: the point is
   * that nobody quietly drops one, since each encodes a rule from the plan rather
   * than a bound that could be recomputed.
   */
  it.each([
    'applications_submitted_has_evidence_check',
    'applications_failed_has_reason_check',
    'applications_cover_letter_single_source_check',
    'job_postings_stated_has_salary_check',
    'job_postings_salary_ordered_check',
    'job_postings_yoe_ordered_check',
    'job_postings_normalized_title_nonempty_check',
    'source_runs_new_within_seen_check',
    'sessions_expiry_within_absolute_check',
    'profile_atoms_embedding_has_hash_check',
    'users_approver_implies_date_check',
  ])('%s is present', (name) => {
    expect(() => checkBody(name)).not.toThrow();
  });
});
