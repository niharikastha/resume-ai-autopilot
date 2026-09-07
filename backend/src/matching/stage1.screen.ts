/**
 * Stage 1 of the matching funnel: the free, deterministic screen.
 *
 * PLAN-v2 phase 4 stage 1 - title include/exclude, dealbreakers, the YOE window,
 * location and remote ELIGIBILITY, freshness, and the already-applied check.
 *
 * PURE, AND THAT IS THE POINT. No database, no clock of its own, no config lookup:
 * everything it decides with is an argument. Stage 1 is the only stage that runs
 * over every posting in the table, it is the stage that throws the most away, and a
 * posting it rejects leaves NO ROW BEHIND - so a rule that is subtly too tight is
 * invisible in the output and can only be caught by a test. Being a pure function of
 * (posting, targets, context) is what makes those tests possible to write.
 *
 * WHY EVERY REJECTION IS A NAMED REASON rather than a boolean. The plan requires
 * each stage to log its survivor count, but a survivor count on its own cannot tell
 * "the rules are too tight" from "discovery found nothing good", and those two have
 * opposite fixes. A histogram of reasons can: 400 rejections on `title-excluded`
 * means the exclude list is doing the work, 400 on `no-must-have-keyword` means the
 * keyword list is.
 *
 * MATCHING IS SUBSTRING MATCHING, as config/targets.yaml documents. That has a known
 * cost - `intern` also matches "internal" - and the exclude-wins ordering is what
 * makes it survivable: `sde` is an include and `sdet` is an exclude, so the SDET
 * roles that the `sde` substring drags in are removed again by a rule that fires
 * second. Anything needing more precision than that belongs in stage 3, where it
 * becomes a low score with a stated reason rather than a silent drop.
 */
import { RemoteType } from '@prisma/client';
import { Targets } from '../config/targets';
import { normalizeTitle } from '../discovery/normalize';

/**
 * Why a posting was dropped. One value per rule, so the histogram names the rule.
 *
 * A union of literals rather than an enum: these are log labels and test
 * expectations, never database values, and a Prisma enum would imply they are
 * storable and stable.
 */
export type RejectReason =
  | 'closed'
  | 'already-applied'
  | 'title-excluded'
  | 'title-not-included'
  | 'seniority'
  | 'experience-window'
  | 'remote-not-applicable'
  | 'location'
  | 'dealbreaker'
  | 'no-must-have-keyword'
  | 'stale'
  | 'no-description';

export type Stage1Verdict =
  | { pass: true }
  /** `matched` names the specific term that fired, so a bad rule in a 150-line
   *  YAML list can be found without bisecting it by hand. */
  | { pass: false; reason: RejectReason; matched?: string };

/** The posting fields stage 1 reads. Nothing else is needed, so nothing else is
 *  selected - this shape is the query's projection as much as it is a type. */
export interface ScreenablePosting {
  id: string;
  title: string;
  /** Already computed by discovery via normalizeTitle. */
  normalizedTitle: string;
  descriptionText: string;
  location: string | null;
  remoteType: RemoteType;
  /** From `seniority()`. A guess from the title, as that function documents. */
  seniority: string | null;
  yoeMin: number | null;
  yoeMax: number | null;
  postedAt: Date | null;
  closedAt: Date | null;
}

export interface ScreenContext {
  /** Passed in rather than read from `new Date()`, so a freshness test is not a
   *  test that stops working in 45 days. */
  now: Date;
  /** Postings this user already has an Application row for. */
  appliedJobIds: ReadonlySet<string>;
}

/**
 * The remote types a candidate in India can actually take.
 *
 * REMOTE_OTHER_REGION is the one this exists to exclude, and PLAN-v2's change to 1c
 * is the measurement behind it: the spike found 509 postings tagged remote that were
 * not India-eligible. "Remote - US" is not a remote job, it is a job in the US.
 */
const APPLICABLE_REMOTE: ReadonlySet<RemoteType> = new Set([
  RemoteType.REMOTE_INDIA,
  RemoteType.REMOTE_GLOBAL,
]);

/** Substring search, with the term already lower-cased by the targets loader. */
function firstMatch(haystack: string, terms: string[]): string | undefined {
  return terms.find((term) => haystack.includes(term));
}

/**
 * Screen one posting.
 *
 * ORDER IS DELIBERATE: cheapest and most certain first. `closed` and
 * `already-applied` are facts rather than judgements; the title rules are one short
 * string; the keyword and dealbreaker rules scan a description that can be twenty
 * kilobytes. Rejecting on the title first means the long scan does not run for the
 * ~90% of postings that were never candidates.
 *
 * It also means the reason histogram attributes a posting to the FIRST rule that
 * fired, not to all of them. That is the useful reading - "this would have been
 * dropped anyway" is not what the histogram is for.
 */
export function screen(
  posting: ScreenablePosting,
  targets: Targets,
  ctx: ScreenContext,
): Stage1Verdict {
  if (posting.closedAt) return { pass: false, reason: 'closed' };

  if (ctx.appliedJobIds.has(posting.id)) {
    return { pass: false, reason: 'already-applied' };
  }

  // Discovery drops description-less postings before writing them, so this should
  // be unreachable. It is checked anyway because the stage-3 prompt would otherwise
  // send an empty description and get back a confident score for nothing.
  if (posting.descriptionText.trim().length === 0) {
    return { pass: false, reason: 'no-description' };
  }

  // Re-normalized rather than trusted: `normalizedTitle` is written by whichever
  // connector found the posting, and a posting seeded before a normalizeTitle fix
  // still carries the old value. The two agree in every ordinary case and this costs
  // one regex.
  const title = normalizeTitle(posting.title);

  const excluded = firstMatch(title, targets.titles.exclude);
  if (excluded) {
    return { pass: false, reason: 'title-excluded', matched: excluded };
  }

  const included = firstMatch(title, targets.titles.include);
  if (!included) return { pass: false, reason: 'title-not-included' };

  // A null seniority passes. `seniority()` always returns one of three values, so
  // null means the row predates that field rather than meaning "unclear", and the
  // allow list currently contains all three anyway - this rule is here so that
  // narrowing the list in the YAML takes effect, not because it currently filters.
  if (
    posting.seniority &&
    !(targets.seniority.allow as readonly string[]).includes(posting.seniority)
  ) {
    return { pass: false, reason: 'seniority', matched: posting.seniority };
  }

  // The experience WINDOW, not a comparison against the candidate's years. A
  // posting that states no requirement always passes - which is most of them - and
  // stage 3 reads the real requirement out of the description, because "5+ years or
  // equivalent experience" is not a number a parser should be trusted with.
  if (
    posting.yoeMin !== null &&
    posting.yoeMin > targets.experience.maxYears
  ) {
    return {
      pass: false,
      reason: 'experience-window',
      matched: `requires ${posting.yoeMin}+ years`,
    };
  }
  if (
    posting.yoeMax !== null &&
    posting.yoeMax < targets.experience.minYears
  ) {
    return {
      pass: false,
      reason: 'experience-window',
      matched: `caps at ${posting.yoeMax} years`,
    };
  }

  const locationVerdict = screenLocation(posting, targets);
  if (locationVerdict) return locationVerdict;

  // The two description scans, last, and over DIFFERENT haystacks. Lower-cased once
  // rather than per rule, because doing it twice over a 20KB body for every posting
  // is the kind of waste that only shows up as a slow nightly run nobody attributes
  // to this.
  const body = posting.descriptionText.toLowerCase();

  // Dealbreakers see the title too: "Sales Engineer (Commission Only)" states its
  // dealbreaker in the title, and no dealbreaker term overlaps an include term, so
  // widening the haystack here cannot cost a good posting.
  const dealbreaker = firstMatch(
    `${title}\n${body}`,
    targets.keywords.dealbreakers,
  );
  if (dealbreaker) {
    return { pass: false, reason: 'dealbreaker', matched: dealbreaker };
  }

  // mustHaveAny sees ONLY the description, and this is load-bearing. The keyword
  // list and the include list overlap heavily by nature - `backend` is a keyword and
  // `backend engineer` is an include term - so scanning the title here would mean
  // every posting that passed the title rule passed this one automatically. The rule
  // would still be in the config, still be documented, and never reject anything.
  // Its actual job is to check that the BODY talks about work the candidate does,
  // which is what catches a "Backend Engineer" posting that turns out to be Java and
  // Kafka on a mainframe.
  if (!firstMatch(body, targets.keywords.mustHaveAny)) {
    return { pass: false, reason: 'no-must-have-keyword' };
  }

  if (posting.postedAt === null) {
    if (!targets.freshness.allowUnknownAge) {
      return { pass: false, reason: 'stale', matched: 'no date reported' };
    }
  } else {
    const ageDays =
      (ctx.now.getTime() - posting.postedAt.getTime()) / 86_400_000;
    if (ageDays > targets.freshness.maxAgeDays) {
      return {
        pass: false,
        reason: 'stale',
        matched: `${Math.round(ageDays)} days old`,
      };
    }
  }

  return { pass: true };
}

/**
 * Location and remote eligibility.
 *
 * Split out because it is the rule with the most branches and the one whose failure
 * mode is worst: a posting in Berlin that reads as addressable ends up in a digest,
 * gets an application, and wastes the day's quota on a job that requires a visa.
 *
 * Returns undefined to mean "no objection", so the caller reads as a chain of
 * rejections rather than as a boolean whose polarity has to be remembered.
 */
function screenLocation(
  posting: ScreenablePosting,
  targets: Targets,
): Stage1Verdict | undefined {
  if (posting.remoteType === RemoteType.REMOTE_OTHER_REGION) {
    return {
      pass: false,
      reason: 'remote-not-applicable',
      matched: posting.location ?? 'remote, another region',
    };
  }

  if (APPLICABLE_REMOTE.has(posting.remoteType)) {
    // REMOTE_INDIA is unambiguous. REMOTE_GLOBAL is "remote, no region stated",
    // which is what most Indian postings that say only "Remote" resolve to - hence
    // it is governed by allowRemoteUnspecified rather than by the location list,
    // which it would never match.
    const allowed =
      posting.remoteType === RemoteType.REMOTE_INDIA
        ? targets.locations.allowRemoteIndia
        : targets.locations.allowRemoteUnspecified;

    return allowed
      ? undefined
      : {
          pass: false,
          reason: 'remote-not-applicable',
          matched: posting.remoteType,
        };
  }

  // ONSITE, HYBRID or UNKNOWN: the location string has to place it somewhere the
  // candidate can work.
  const location = posting.location?.toLowerCase().trim() ?? '';
  if (location.length === 0) {
    return targets.locations.allowRemoteUnspecified
      ? undefined
      : { pass: false, reason: 'location', matched: 'no location stated' };
  }

  return firstMatch(location, targets.locations.allow)
    ? undefined
    : { pass: false, reason: 'location', matched: location };
}

/** Counts of each rejection reason, for the per-stage log the plan requires. */
export type RejectHistogram = Partial<Record<RejectReason, number>>;

/**
 * Screens many postings and reports why the losers lost.
 *
 * The histogram is the tuning instrument. PLAN-v2's own guidance is that with real
 * volume at ~3-6 relevant roles a day, stage 1 rejecting almost everything means the
 * rules are too tight rather than the pool being bad - and this is what makes that
 * judgement possible to make from a log line.
 */
export function screenAll<T extends ScreenablePosting>(
  postings: T[],
  targets: Targets,
  ctx: ScreenContext,
): { survivors: T[]; rejected: RejectHistogram; examples: Map<RejectReason, string> } {
  const survivors: T[] = [];
  const rejected: RejectHistogram = {};
  // One worked example per reason. Enough to see what a rule is actually catching
  // without printing 400 lines.
  const examples = new Map<RejectReason, string>();

  for (const posting of postings) {
    const verdict = screen(posting, targets, ctx);
    if (verdict.pass) {
      survivors.push(posting);
      continue;
    }

    rejected[verdict.reason] = (rejected[verdict.reason] ?? 0) + 1;
    if (!examples.has(verdict.reason)) {
      examples.set(
        verdict.reason,
        `${posting.title}${verdict.matched ? ` <- "${verdict.matched}"` : ''}`,
      );
    }
  }

  return { survivors, rejected, examples };
}
