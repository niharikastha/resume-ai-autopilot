/**
 * The dials for outbound job-board traffic, in one place.
 *
 * These are conservative on purpose and should stay that way. We are an unpaid,
 * unannounced consumer of somebody else's API, and the failure mode of being
 * greedy is not a slow run - it is an IP block that removes a source permanently
 * and cannot be undone by fixing the code afterwards. The whole daily pass has
 * until morning to finish; nothing here needs to be fast.
 */

/** Version reported in the User-Agent. Bump when request behaviour changes. */
export const DISCOVERY_VERSION = '0.2';

/**
 * Boards fetched at once, across all sources.
 *
 * The spike used 8 against a mixed set of hosts. 4 here because the connectors are
 * grouped by source, so concurrency now lands mostly on ONE host at a time rather
 * than being spread over four - the same number is a four-fold increase in load on
 * whoever we happen to be reading.
 */
export const FETCH_CONCURRENCY = 4;

/**
 * Minimum gap between two requests to the same host, milliseconds.
 *
 * Enforced per host rather than globally: the point is to be gentle on each
 * operator, and a global delay would throttle us needlessly when consecutive
 * requests happen to go to different companies' ATSes.
 */
export const PER_HOST_MIN_INTERVAL_MS = 1_200;

/** Per-request ceiling. One board hanging must not stall the pass. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Attempts per board, including the first.
 *
 * 3 is chosen against what the errors mean: a timeout or a 502 is usually
 * transient and worth one more try, while anything a fourth attempt would fix is
 * an outage that the next daily run should pick up instead of us sitting here.
 */
export const MAX_ATTEMPTS = 3;

/** First retry delay; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Longest we will honour a `Retry-After`.
 *
 * A server asking for an hour is telling us to go away, and waiting an hour with a
 * connection open is worse for both sides than failing the board and returning
 * tomorrow. Capped rather than ignored - the header is a request we respect up to
 * the point where respecting it stops being cooperative.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Largest response body accepted, bytes.
 *
 * Greenhouse with `content=true` on a large employer is genuinely several MB, so
 * this is not tight. It exists because a streamed response has no declared length
 * to trust, and an unbounded read is how one pathological board turns into an
 * out-of-memory kill of the worker mid-pass.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Consecutive empty runs before a board drops to the weekly cadence.
 *
 * Matches the `yieldStats` note on the Company model: the point is that the board
 * list can grow ten-fold without the daily pass slowing down proportionally,
 * because most of the additions will be boards that never have anything.
 */
export const EMPTY_RUNS_BEFORE_DEMOTION = 5;

/** How often a demoted board is retried anyway, days. */
export const DEMOTED_BOARD_INTERVAL_DAYS = 7;

/**
 * Fraction of a board's previously-seen postings that must vanish in one pass
 * before we DISBELIEVE the result and leave the postings open.
 *
 * A board returning 200 with an empty list is indistinguishable, from the outside,
 * between "every role was filled today" and "the ATS had a bad deploy". Marking
 * postings closed is destructive to the funnel - a closed posting stops being
 * scored or applied to - so a sudden total disappearance is treated as a fault to
 * be logged rather than a fact to be recorded.
 */
export const MAX_PLAUSIBLE_CLOSURE_RATIO = 0.9;
