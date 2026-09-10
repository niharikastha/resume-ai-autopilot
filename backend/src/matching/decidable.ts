import { MatchVerdict } from '@prisma/client';

/**
 * The verdicts a candidate is asked to decide about.
 *
 * WEAK and REJECT are excluded: putting fifty rejected postings in front of someone
 * every morning trains them to ignore the digest, which costs more than the small
 * chance that the model was wrong about one of them. They remain on the Jobs page,
 * where looking at them is a deliberate act.
 *
 * BORDERLINE is INCLUDED here even though tailoring excludes it, and the difference is
 * the point: borderline is precisely the verdict that wants a human, and this is the
 * screen where a human is looking.
 *
 * ONE LIST, IN ONE PLACE. It lives here rather than in the digest because two readings
 * of "how many are waiting for you" is a screen that says one and a tile that says two
 * hundred - which is exactly the bug this file was extracted to fix. The digest builds
 * its morning count from this, and MatchesService.summary answers the live count from
 * the same list, so the two can only ever differ by what has happened since.
 */
export const DECIDABLE: MatchVerdict[] = [
  MatchVerdict.STRONG,
  MatchVerdict.GOOD,
  MatchVerdict.BORDERLINE,
];
