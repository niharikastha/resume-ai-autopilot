/**
 * The retention rules, checked against the property that actually matters:
 * a row that can still authenticate somebody must never match a delete filter.
 *
 * These tests evaluate the Prisma filters in JS rather than against a database.
 * That is a deliberate trade - it will not catch a filter Prisma rejects
 * (typecheck does), but it does catch the failure that would hurt, which is a
 * boundary drifting so that live sessions start getting swept up. No database is
 * needed, so it runs in CI and in a pre-commit hook.
 */
import {
  authPruneFilters,
  REVOKED_RETENTION_DAYS,
  RESET_RETENTION_DAYS,
} from './auth-retention';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

/** Minimal stand-in for the session columns the filter reads. */
interface SessionRow {
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Evaluates the session filter the way Postgres would.
 *
 * Hand-written rather than derived from the filter object, so that if someone
 * changes the filter's SHAPE - swaps OR for AND, adds a clause - this stops
 * matching and the test fails loudly instead of silently agreeing with whatever
 * the new shape does.
 */
function sessionMatches(row: SessionRow, now: Date): boolean {
  const f = authPruneFilters(now).sessions;
  const clauses = f.OR;
  if (!Array.isArray(clauses) || clauses.length !== 2) {
    throw new Error(
      'session filter shape changed: expected exactly two OR clauses. ' +
        'Update this test deliberately, and re-check that live rows still cannot match.',
    );
  }
  const ceiling = clauses[0] as { absoluteExpiresAt: { lt: Date } };
  const revoked = clauses[1] as { revokedAt: { lt: Date } };
  return (
    row.absoluteExpiresAt < ceiling.absoluteExpiresAt.lt ||
    (row.revokedAt !== null && row.revokedAt < revoked.revokedAt.lt)
  );
}

describe('authPruneFilters', () => {
  describe('sessions: nothing usable is ever selected', () => {
    it('spares a live session whose ceiling is in the future', () => {
      expect(
        sessionMatches({ absoluteExpiresAt: days(89), revokedAt: null }, NOW),
      ).toBe(false);
    });

    it('spares a session revoked seconds ago, so the audit trail survives', () => {
      expect(
        sessionMatches(
          {
            absoluteExpiresAt: days(89),
            revokedAt: new Date(NOW.getTime() - 1000),
          },
          NOW,
        ),
      ).toBe(false);
    });

    it('spares a just-rotated row, so replay detection still fires', () => {
      // The whole point of keeping spent rows: presenting this token again is
      // what triggers family-wide revocation.
      expect(
        sessionMatches(
          {
            absoluteExpiresAt: days(89),
            revokedAt: days(-(REVOKED_RETENTION_DAYS - 1)),
          },
          NOW,
        ),
      ).toBe(false);
    });

    it('deletes a session past its absolute ceiling', () => {
      expect(
        sessionMatches({ absoluteExpiresAt: days(-1), revokedAt: null }, NOW),
      ).toBe(true);
    });

    it('deletes rotation debris older than the retention window', () => {
      expect(
        sessionMatches(
          {
            absoluteExpiresAt: days(60),
            revokedAt: days(-(REVOKED_RETENTION_DAYS + 1)),
          },
          NOW,
        ),
      ).toBe(true);
    });

    it('holds the boundary at exactly the retention window', () => {
      // `lt`, not `lte`: a row revoked exactly on the boundary is kept. Which
      // side this falls on barely matters, but it should not change by accident.
      expect(
        sessionMatches(
          {
            absoluteExpiresAt: days(60),
            revokedAt: days(-REVOKED_RETENTION_DAYS),
          },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('access tokens', () => {
    it('selects expired ones and only expired ones', () => {
      const { accessTokens } = authPruneFilters(NOW);
      const cutoff = (accessTokens.expiresAt as { lt: Date }).lt;
      // No grace period is correct here: resolveAccessToken already refuses an
      // expired token, so a row past expiry cannot authenticate anybody.
      expect(cutoff).toEqual(NOW);
      expect(days(-1) < cutoff).toBe(true);
      expect(days(1) < cutoff).toBe(false);
    });
  });

  describe('password resets', () => {
    it('keeps expired requests for the audit window before deleting', () => {
      const { resets } = authPruneFilters(NOW);
      const cutoff = (resets.expiresAt as { lt: Date }).lt;
      expect(cutoff).toEqual(days(-RESET_RETENTION_DAYS));

      // Expired an hour ago - unusable, but recent enough that "who has been
      // asking for resets on my account" should still be answerable.
      const justExpired = new Date(NOW.getTime() - 3600_000);
      expect(justExpired < cutoff).toBe(false);

      expect(days(-(RESET_RETENTION_DAYS + 1)) < cutoff).toBe(true);
    });
  });

  it('moves every boundary with the clock', () => {
    const later = new Date(NOW.getTime() + 10 * DAY_MS);
    const a = authPruneFilters(NOW);
    const b = authPruneFilters(later);
    expect((b.accessTokens.expiresAt as { lt: Date }).lt).toEqual(later);
    expect((b.resets.expiresAt as { lt: Date }).lt.getTime()).toBe(
      (a.resets.expiresAt as { lt: Date }).lt.getTime() + 10 * DAY_MS,
    );
  });
});
