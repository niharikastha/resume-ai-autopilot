import type { TrackedApplication, TrackedStage } from '@/lib/api';

/**
 * The stages of a hand-tracked application, in the order they happen.
 *
 * NOT `STATUS_LABEL` from lib/utils, which is deliberately a different vocabulary: those
 * are states of a form-filling job the machine is running - "Queued", "Form filled" - and
 * none of them is a thing an employer ever tells you. Sharing one map between the two would
 * give this screen a "Queued" option that means nothing here, and give the applications
 * screen an "Offer" it can never reach.
 */
export const STAGE_ORDER: TrackedStage[] = [
  'SAVED',
  'APPLIED',
  'SCREENING',
  'INTERVIEWING',
  'OFFER',
  'REJECTED',
  'GHOSTED',
];

export const STAGE_LABEL: Record<TrackedStage, string> = {
  SAVED: 'Saved, not applied',
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEWING: 'Interviewing',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  // "No answer" rather than "Ghosted", which is a word about them rather than about the
  // state of the application - and this is a list somebody reads on a bad afternoon.
  GHOSTED: 'No answer',
};

/**
 * The colour a stage carries, or null for the two that carry none.
 *
 * BY OUTCOME, not by system health, which is what these variables mean everywhere else in
 * this app. Red on a rejection is not claiming something broke; it is the one thing a person
 * scanning forty rows is looking for. "No answer" is amber rather than red because it is not
 * over - it is the state where a follow-up is still worth sending.
 *
 * SAVED and APPLIED are deliberately uncoloured. They are the resting states and most of the
 * list is in them, so tinting them would spend the reader's attention on the rows that have
 * not done anything yet.
 *
 * A CSS variable rather than a `Badge` tone, because the control this paints is a dropdown -
 * the stage is the one field edited in place, so the colour has to live on the thing that
 * edits it rather than on a badge sitting beside it saying the same word twice.
 */
export const STAGE_COLOR: Record<TrackedStage, string | null> = {
  SAVED: null,
  APPLIED: null,
  SCREENING: 'var(--accent)',
  INTERVIEWING: 'var(--accent)',
  OFFER: 'var(--status-good)',
  REJECTED: 'var(--status-critical)',
  GHOSTED: 'var(--status-warning)',
};

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A `YYYY-MM-DD` day, short: "12 Sep 2026".
 *
 * Split into numbers rather than handed to `new Date(day)`, for the reason `dayLabel` in
 * lib/utils spells out: that constructor reads a bare date as UTC midnight and then prints
 * it in the local zone, so in India every date would display as the day before.
 *
 * `dayLabel` itself is the long form ("Thursday 10 September") and is right for the digest's
 * heading. Forty of those down a column is not readable, hence a second formatter.
 */
export function shortDay(day: string | null): string {
  if (!day) return '—';
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/**
 * How a row's referral reads.
 *
 * Three states and not two, because "a referral went in and I no longer remember through
 * whom" is a real thing to have recorded - see the schema note on `referrerId`. Flattening
 * it into "no referral" would quietly delete the more useful half of what somebody wrote.
 */
export function referralText(row: TrackedApplication): string {
  if (!row.referralGiven) return 'No referral';
  if (!row.referrer) return 'Referred, source not recorded';
  return row.referrer.company
    ? `Referred by ${row.referrer.name} · ${row.referrer.company}`
    : `Referred by ${row.referrer.name}`;
}
