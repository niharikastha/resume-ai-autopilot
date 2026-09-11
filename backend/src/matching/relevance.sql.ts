/**
 * "Could this posting be for me at all", as a SQL predicate.
 *
 * WHY THIS EXISTS. The jobs page groups 16,500 open postings by employer, and a row
 * reading "780 openings" was worse than useless: OpenAI's board is mostly marketing and
 * sales roles in Tokyo and Dublin, and the reader has to open the row and scroll to find
 * that out. The row should count what the reader could actually apply for. Counting that
 * means applying the screen to every open posting in the table, which is a query, not a
 * loop - `screen()` needs the full 20KB description of every posting and there are
 * sixteen thousand of them.
 *
 * SO THE TERMS COME FROM config/targets.yaml, THE SAME FILE STAGE 1 READS. Not a second
 * copy of the vocabulary. A hand-maintained duplicate would drift on the first title
 * anybody added, and the symptom would be a count that quietly disagrees with the screen
 * it claims to predict - the kind of wrong number that is only discoverable by opening
 * the row and counting by hand, which is exactly what the count exists to save.
 *
 * IT IS COARSER THAN STAGE 1, DELIBERATELY, AND ONLY IN THE LOOSER DIRECTION. Three of
 * stage 1's rules are missing here:
 *
 *   - the dealbreaker and must-have-keyword scans, which read the description body
 *   - freshness, which needs a clock and would make a cached count wrong at midnight
 *   - already-applied, which is per-candidate and belongs on the applications screen
 *
 * Every rule that IS here is applied exactly as stage 1 applies it. So this predicate is
 * a SUPERSET of what a match run will shortlist: a company row can promise 12 and the
 * run can shortlist 7, never the other way round. That asymmetry is the point - a page
 * that overstates by a few is a page you go and look at, and a page that understates
 * hides jobs.
 *
 * The one substitution: stage 1 re-normalizes `title` before matching, this reads the
 * stored `normalizedTitle`. Stage 1's own comment says the two agree in every ordinary
 * case, and re-normalizing 16,500 titles per page view to catch a row that predates a
 * normalizeTitle fix is not a trade worth making.
 *
 * EVERY CALLER MUST ALIAS job_postings AS `j`. The predicate references `j."..."`
 * rather than taking an alias argument, because an interpolated identifier is the one
 * thing Prisma.sql cannot parameterise and there is no reason to open that door.
 */
import { Prisma, RemoteType } from '@prisma/client';
import { Targets } from '../config/targets';
import { PLACELESS_WORDS } from './stage1.screen';

/**
 * A term list as one case-insensitive Postgres pattern.
 *
 * `\y` is Postgres's word boundary - `\b` is a backspace in its regex dialect, which is
 * the sort of difference that produces a pattern matching nothing rather than an error.
 * The trailing inflections are stage 1's, for the same reason stage 1 has them: the
 * lists are written in the singular and titles are not, so `manager` has to reach
 * "Engineering Managers" while `intern` still must not reach "internal".
 */
export function alternation(terms: readonly string[]): string {
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `\\y(?:${escaped.join('|')})(?:s|es|ing|ings)?\\y`;
}

/** Lower-cased, trimmed location text, matching what stage 1 compares against. */
const LOCATION = Prisma.sql`btrim(lower(coalesce(j.location, '')))`;

/**
 * Stage 1's `namesAPlace`, subtractively: strike out every word that means "nowhere",
 * then the digits and punctuation, and see whether any letters are left.
 *
 * The word list is NOT escaped, unlike the term lists above. Its entries are regex
 * fragments by design - `locations?` covers both spellings in one - and they are a
 * constant in this repo rather than anything a user supplies.
 */
const NAMES_A_PLACE = Prisma.sql`
  regexp_replace(
    regexp_replace(${LOCATION}, ${`\\y(${PLACELESS_WORDS.join('|')})\\y`}, ' ', 'g'),
    '[^a-z]+', '', 'g'
  ) <> ''
`;

/**
 * The predicate itself.
 *
 * Built per call rather than cached: `loadTargets` is already cached, this is string
 * concatenation over a few hundred terms, and a cached fragment would go stale the
 * moment somebody edited the YAML - the failure being a page that keeps counting by
 * yesterday's rules with nothing to show that it is.
 */
export function suitsCandidateSql(targets: Targets): Prisma.Sql {
  const include = alternation(targets.titles.include);
  const exclude =
    targets.titles.exclude.length > 0
      ? alternation(targets.titles.exclude)
      : null;
  const places = alternation(targets.locations.allow);

  return Prisma.sql`
    j."normalizedTitle" ~* ${include}
    ${
      exclude
        ? Prisma.sql`AND j."normalizedTitle" !~* ${exclude}`
        : Prisma.empty
    }

    -- A null seniority passes, as it does in stage 1: the column means "this row
    -- predates the field", not "unclear".
    AND (
      j.seniority IS NULL
      OR j.seniority IN (${Prisma.join(targets.seniority.allow)})
    )

    -- The experience WINDOW, not a comparison against the candidate's years. A posting
    -- that states no requirement passes, which is most of them.
    AND (j."yoeMin" IS NULL OR j."yoeMin" <= ${targets.experience.maxYears})
    AND (j."yoeMax" IS NULL OR j."yoeMax" >= ${targets.experience.minYears})

    AND ${locationSql(targets, places)}
  `;
}

/**
 * Location and remote eligibility, branch for branch as `screenLocation` has it.
 *
 * The branch that matters most is REMOTE_GLOBAL. It does NOT mean "the posting named no
 * region" - it means the region parser recognised nothing - so "Remote Poland" and
 * "Hungary - Budapest" land here. Stage 1's comment records 74 foreign jobs sitting in
 * this bucket in the live table, four shortlisted GOOD. Accepting the whole bucket
 * because the candidate ticked "remote is fine" would put every one of them on a company
 * row as an opening they could take.
 */
function locationSql(targets: Targets, places: string): Prisma.Sql {
  // Compared as text rather than against the enum type. `WHEN $1::"RemoteType"` would
  // work too, but it hard-codes the name Prisma happened to give the Postgres type into
  // a string, and a rename would fail at runtime on a page nobody typechecks.
  const remote = Prisma.sql`j."remoteType"::text`;

  return Prisma.sql`
    CASE
      WHEN ${remote} = ${RemoteType.REMOTE_OTHER_REGION}
        THEN ${targets.locations.allowRemoteOtherRegion}
      WHEN ${remote} = ${RemoteType.REMOTE_INDIA}
        THEN ${targets.locations.allowRemoteIndia}
      WHEN ${remote} = ${RemoteType.REMOTE_GLOBAL}
        THEN ${targets.locations.allowRemoteUnspecified}
             AND (NOT (${NAMES_A_PLACE}) OR ${LOCATION} ~* ${places})
      -- ONSITE, HYBRID, UNKNOWN: the string has to place it somewhere workable, and an
      -- empty string is only acceptable if unspecified locations are.
      WHEN ${LOCATION} = '' THEN ${targets.locations.allowRemoteUnspecified}
      ELSE ${LOCATION} ~* ${places}
    END
  `;
}
