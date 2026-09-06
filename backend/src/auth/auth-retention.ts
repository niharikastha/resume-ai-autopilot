/**
 * How long dead auth rows are kept, and the queries that select them.
 *
 * Its own module, importing NOTHING but Prisma's types, because two things need
 * these rules: the nightly SessionCleanupService and the `prune-auth` CLI
 * command. The CLI deliberately avoids booting the Nest container, so it cannot
 * reach into the service - and a second copy of "which rows are safe to delete"
 * is exactly the kind of duplication that goes wrong quietly. One definition, two
 * callers.
 */
import type { Prisma } from '@prisma/client';

/**
 * Dead session rows are kept this long rather than deleted on revocation.
 *
 * Two reasons, and the second is the load-bearing one:
 *
 * 1. `revokedReason` is the only record of WHY a session ended - "logout",
 *    "reuse-detected", "password-change". Deleting on revocation means that by
 *    the time anyone asks "was this account attacked?", the answer is gone.
 *
 * 2. Replay detection needs the spent row to still exist. Presenting an
 *    already-rotated refresh token is what triggers family-wide revocation; if
 *    the row has been deleted, that same replay is merely rejected as unknown,
 *    which logs the caller out but leaves the thief's OTHER stolen tokens
 *    working. 30 days is far beyond any realistic replay window.
 */
export const REVOKED_RETENTION_DAYS = 30;

/**
 * Reset requests are kept the same 30 days past expiry, so "who has been asking
 * for resets on my account" stays answerable for a month. That is the question
 * PasswordReset.userAgent exists to answer.
 */
export const RESET_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthPruneFilters {
  sessions: Prisma.SessionWhereInput;
  accessTokens: Prisma.AccessTokenWhereInput;
  resets: Prisma.PasswordResetWhereInput;
}

/**
 * The three sets of rows that are safe to delete as of `now`.
 *
 * Three separate filters rather than one clever query: they have different
 * retention rules and different safety arguments, and collapsing them would hide
 * that. The safety property they share is that NO row still usable for
 * authentication can match - see the spec, which pins that directly.
 */
export function authPruneFilters(now: Date): AuthPruneFilters {
  const revokedBefore = new Date(
    now.getTime() - REVOKED_RETENTION_DAYS * DAY_MS,
  );
  const resetsBefore = new Date(now.getTime() - RESET_RETENTION_DAYS * DAY_MS);

  return {
    sessions: {
      OR: [
        // Past the hard ceiling set at login. Rotation cannot extend beyond
        // this, so no descendant of this row can ever be exchanged again and
        // there is nothing left to detect a replay of.
        { absoluteExpiresAt: { lt: now } },
        // Revoked or spent long enough ago that the audit trail has served its
        // purpose. This is what actually clears rotation debris: a spent row
        // inherits its family's ceiling, so without this clause it would sit
        // for the full 90 days.
        { revokedAt: { lt: revokedBefore } },
      ],
    },

    // No retention argument for these. An expired access token has no reason
    // field and no history, resolveAccessToken already refuses it, and the
    // session row it belongs to keeps the audit trail. Cascade would remove them
    // with their session eventually - this stops them sitting for the session's
    // 90-day lifetime when their own is 15 minutes.
    accessTokens: { expiresAt: { lt: now } },

    // One rule covers both outcomes. A reset link is short-lived, so 30 days
    // past expiry is a generous window whether it was used or ignored, and an
    // expired row is unusable either way because resetPassword checks both
    // expiresAt and usedAt before honouring it.
    resets: { expiresAt: { lt: resetsBefore } },
  };
}
