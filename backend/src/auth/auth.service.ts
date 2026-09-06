import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, type User } from '@prisma/client';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Env } from '../config/env.schema';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_TTL_MS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_MAX_PER_HOUR,
  PASSWORD_RESET_TTL_MS,
  REFRESH_ABSOLUTE_TTL_MS,
  REFRESH_IDLE_TTL_MS,
  REFRESH_REUSE_GRACE_MS,
  type SessionUser,
} from './auth.constants';
import { hashPassword, verifyPassword } from './password';

/** A dummy hash to compare against when the email does not exist, so a missing
 *  account and a wrong password cost the same time and cannot be distinguished
 *  by timing. Computed once at boot. */
let DUMMY_HASH: Promise<string> | null = null;

/** What a login or a refresh hands back to the controller, which turns it into
 *  two Set-Cookie headers. The raw tokens exist only in this return value and in
 *  the response - never in the database, never in a log line. */
export interface TokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

/** Thrown when a refresh cookie is spent but the race was almost certainly
 *  benign - two tabs refreshing together. The controller turns this into a 401
 *  that the client retries ONCE, having by then picked up the winner's cookie. */
export class RefreshRaceException extends UnauthorizedException {
  constructor() {
    super('Session was refreshed in another tab. Retry.');
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {
    DUMMY_HASH ??= hashPassword(randomBytes(32).toString('hex'));
  }

  /** Tokens are stored only as SHA-256, so a database dump does not hand over
   *  live sessions. No salt and no slow KDF here on purpose: these are 256-bit
   *  random values, so there is no dictionary to attack. */
  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private static newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private static assertPasswordLength(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
      // Length is the only rule. Composition rules push people toward
      // "Password1!" - which is worse than a long passphrase.
      throw new BadRequestException(
        `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      );
    }
  }

  // ---------------------------------------------------------------- login ----

  async login(
    email: string,
    password: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : // Burn equivalent time so "no such account" is not observable.
        await verifyPassword(password, await DUMMY_HASH!).then(() => false);

    // One message for every credential failure. Distinguishing "no such user"
    // from "wrong password" hands an attacker a user enumeration oracle.
    if (!ok || !user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Account state, on the other hand, is only revealed AFTER a correct
    // password, so it is not an oracle - you cannot learn it without already
    // holding the credential. And it has to be revealed: self-signup means real
    // people will sit at this door with a correct password and no idea why it
    // will not open, and "invalid email or password" would be a lie.
    if (!user.active) {
      throw new ForbiddenException(
        user.approvedAt
          ? 'This account has been suspended. Contact the administrator.'
          : 'This account is waiting for administrator approval. You will be able to sign in once it is approved.',
      );
    }

    // A fresh login starts a NEW family with its own absolute ceiling. Rotation
    // walks the family forward; it can never move this date.
    const now = Date.now();
    const pair = await this.issuePair({
      userId: user.id,
      familyId: randomUUID(),
      absoluteExpiresAt: new Date(now + REFRESH_ABSOLUTE_TTL_MS),
      userAgent,
    });

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
      // Opportunistic sweep - dead rows have no value and login is the one place
      // guaranteed to run regularly without a dedicated cron.
      this.prisma.accessToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }),
      this.prisma.session.deleteMany({
        where: { absoluteExpiresAt: { lt: new Date() } },
      }),
      this.prisma.passwordReset.deleteMany({
        where: { expiresAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    return { ...pair, user: AuthService.toSessionUser(user) };
  }

  /**
   * Write one refresh row and one access row. Both raw tokens are returned and
   * neither is retrievable afterwards.
   */
  private async issuePair(input: {
    userId: string;
    familyId: string;
    absoluteExpiresAt: Date;
    userAgent?: string;
  }): Promise<Omit<TokenPair, 'user'>> {
    const refreshToken = AuthService.newToken();
    const accessToken = AuthService.newToken();
    const now = Date.now();

    // The sliding window never reaches past the absolute ceiling, so the last
    // refresh before expiry gets a short window rather than one that outlives
    // the session it belongs to.
    const refreshExpiresAt = new Date(
      Math.min(now + REFRESH_IDLE_TTL_MS, input.absoluteExpiresAt.getTime()),
    );
    const accessExpiresAt = new Date(
      Math.min(now + ACCESS_TTL_MS, refreshExpiresAt.getTime()),
    );

    await this.prisma.session.create({
      data: {
        refreshTokenHash: AuthService.hashToken(refreshToken),
        userId: input.userId,
        familyId: input.familyId,
        refreshExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        userAgent: input.userAgent?.slice(0, 200),
        accessTokens: {
          create: {
            tokenHash: AuthService.hashToken(accessToken),
            expiresAt: accessExpiresAt,
          },
        },
      },
    });

    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt };
  }

  // ------------------------------------------------------------- resolve ----

  /**
   * Resolve an ACCESS cookie to a user, or null. This runs on every request, so
   * it is one indexed lookup and nothing else.
   */
  async resolveAccessToken(token: string): Promise<SessionUser | null> {
    const access = await this.prisma.accessToken.findUnique({
      where: { tokenHash: AuthService.hashToken(token) },
      include: { session: { include: { user: true } } },
    });

    const now = new Date();
    if (!access || access.expiresAt < now) return null;

    const { session } = access;
    // The access token is short-lived but the session behind it can be killed at
    // any moment - by a logout, a password reset, or replay detection. Checking
    // it here is what makes revocation immediate, and is the whole reason these
    // are database rows and not JWTs.
    if (session.revokedAt || session.refreshExpiresAt < now) return null;
    if (!session.user.active) return null;

    void this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: now } })
      .catch(() => undefined);

    return AuthService.toSessionUser(session.user);
  }

  // ------------------------------------------------------------- refresh ----

  /**
   * Rotate a refresh token: the presented one is spent, and a successor is
   * issued in the same family.
   *
   * Rotation is what makes a long-lived refresh cookie tolerable. A stolen copy
   * is only useful until the legitimate client next refreshes, and the moment
   * BOTH are used the collision is detectable - which is the job of the
   * `rotatedAt` branch below.
   */
  async refresh(token: string, userAgent?: string): Promise<TokenPair> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: AuthService.hashToken(token) },
      include: { user: true },
    });

    if (!session) throw new UnauthorizedException('Session is not valid');

    const now = new Date();

    if (session.rotatedAt) {
      // Already spent. Either two of our own tabs raced, or someone kept a copy.
      if (
        now.getTime() - session.rotatedAt.getTime() <=
        REFRESH_REUSE_GRACE_MS
      ) {
        throw new RefreshRaceException();
      }
      // Outside the grace window there is no benign story left. Revoke the whole
      // FAMILY, not just this row: we cannot tell whether the thief or the user
      // holds the current token, so the only safe move is to invalidate both and
      // make everyone re-authenticate with a password.
      await this.revokeFamily(session.familyId, 'refresh-token-reuse');
      this.logger.warn(
        `refresh token replay for ${session.user.email}; revoked family ${session.familyId}`,
      );
      throw new UnauthorizedException(
        'This session was replaced and has been revoked. Please sign in again.',
      );
    }

    if (session.revokedAt) {
      throw new UnauthorizedException('Session has been revoked');
    }
    if (session.refreshExpiresAt < now || session.absoluteExpiresAt < now) {
      throw new UnauthorizedException('Session has expired');
    }
    if (!session.user.active) {
      throw new ForbiddenException('This account is not active');
    }

    const pair = await this.issuePair({
      userId: session.userId,
      familyId: session.familyId,
      absoluteExpiresAt: session.absoluteExpiresAt,
      userAgent: userAgent ?? session.userAgent ?? undefined,
    });

    await this.prisma.$transaction([
      // rotatedAt is set rather than the row deleted: a deleted row is
      // indistinguishable from a token that never existed, and replay detection
      // depends on being able to tell those apart.
      this.prisma.session.update({
        where: { id: session.id },
        data: { rotatedAt: now, revokedAt: now, revokedReason: 'rotated' },
      }),
      // The predecessor's access token dies with it, so exactly one access token
      // in the family is live at a time.
      this.prisma.accessToken.deleteMany({ where: { sessionId: session.id } }),
    ]);

    return { ...pair, user: AuthService.toSessionUser(session.user) };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.accessToken.deleteMany({ where: { session: { familyId } } }),
      this.prisma.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
      // A rotated ancestor keeps its row (see above) but must not keep a live
      // refresh window.
      this.prisma.session.updateMany({
        where: { familyId, refreshExpiresAt: { gt: new Date() } },
        data: { refreshExpiresAt: new Date() },
      }),
    ]);
  }

  /** Logging out kills the whole family, not just the presented token - the
   *  ancestors are spent but their rows are still the audit trail. */
  async logout(refreshToken?: string, accessToken?: string): Promise<void> {
    if (refreshToken) {
      const session = await this.prisma.session.findUnique({
        where: { refreshTokenHash: AuthService.hashToken(refreshToken) },
        select: { familyId: true },
      });
      if (session) {
        await this.revokeFamily(session.familyId, 'logout');
        return;
      }
    }
    // No usable refresh cookie (path-scoped, so a stale one is possible). Fall
    // back to the access token so "log out" still means something.
    if (accessToken) {
      const access = await this.prisma.accessToken.findUnique({
        where: { tokenHash: AuthService.hashToken(accessToken) },
        select: { session: { select: { familyId: true } } },
      });
      if (access) await this.revokeFamily(access.session.familyId, 'logout');
    }
  }

  /** Every session for a user, everywhere. Used by password reset and by the
   *  admin suspend action. */
  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.accessToken.deleteMany({ where: { session: { userId } } }),
      this.prisma.session.updateMany({
        where: { userId },
        data: {
          revokedAt: new Date(),
          revokedReason: reason,
          refreshExpiresAt: new Date(),
        },
      }),
    ]);
  }

  // -------------------------------------------------------------- signup ----

  /**
   * Self-signup. Creates an INACTIVE account that cannot sign in until an admin
   * approves it, so an open signup form is not an open door.
   *
   * Returns nothing, and takes the same path whether or not the address is
   * already registered - otherwise the form is a user enumeration oracle for
   * anyone with a browser. The cost is that a duplicate signup gets no specific
   * feedback; the response text is written to cover both cases honestly.
   */
  async signup(input: {
    email: string;
    name: string;
    password: string;
    userAgent?: string;
  }): Promise<void> {
    AuthService.assertPasswordLength(input.password);
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      this.logger.log(`signup for existing address ${email}; ignored`);
      return;
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        name: input.name.trim(),
        // NOT from the request body, and deliberately not a parameter of this
        // method either. A self-service caller must have no way to express a
        // role - the strongest form of "you cannot ask for admin" is that the
        // field is not reachable from here at all.
        role: Role.USER,
        // The two halves of "pending": cannot sign in, and never reviewed.
        active: false,
        approvedAt: null,
        passwordHash: await hashPassword(input.password),
      },
    });

    this.logger.log(`signup pending approval: ${user.email}`);
  }

  /**
   * Admin approval. Activating for the first time stamps approvedAt, which is
   * what separates "new, never reviewed" from "approved once, later suspended".
   */
  async setActive(
    targetUserId: string,
    active: boolean,
    actor: SessionUser,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
    });

    if (!active && user.id === actor.id) {
      // Not a hypothetical: the admin list shows your own row.
      throw new BadRequestException('You cannot deactivate your own account');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        active,
        // Stamped once and then left alone - it records when the account was
        // vetted, not when it was last toggled.
        //
        // The third branch is for accounts that predate this column: created
        // active by the CLI, so approvedAt is null even though they were never
        // pending. Suspending one without backfilling would leave it inactive
        // AND unapproved, which the admin list reads as "new signup, never
        // reviewed" - the wrong label and the wrong action offered. They were
        // trusted from the moment they were created, so that is the honest date.
        approvedAt: user.approvedAt ?? (active ? new Date() : user.createdAt),
        approvedById: user.approvedById ?? (active ? actor.id : null),
      },
    });

    if (!active) {
      // Deactivating has to end live sessions, or the flag is advisory for the
      // next 15 minutes.
      await this.revokeAllSessions(user.id, 'account-deactivated');
    }

    this.logger.log(
      `${actor.email} ${active ? 'activated' : 'deactivated'} ${user.email}`,
    );

    if (active && !user.approvedAt && this.mail.configured) {
      // Best-effort: the approval already succeeded and must not be rolled back
      // because a mail server was unreachable.
      const url = this.config.get('APP_URL', { infer: true });
      void this.mail
        .send(this.mail.accountApproved(user.email, user.name, `${url}/login`))
        .catch(() => undefined);
    }
  }

  // ------------------------------------------------------ password resets ----

  /**
   * Send a reset link. Always resolves, whether or not the address exists.
   *
   * The SMTP check happens FIRST and does throw, which is safe: whether this
   * server can send mail at all is a property of the server, not of the address
   * being asked about, so it reveals nothing about who has an account.
   */
  async requestPasswordReset(email: string, userAgent?: string): Promise<void> {
    this.mail.assertConfigured();

    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user) {
      this.logger.log('password reset requested for unknown address; ignored');
      return;
    }

    const recent = await this.prisma.passwordReset.count({
      where: {
        userId: user.id,
        createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (recent >= PASSWORD_RESET_MAX_PER_HOUR) {
      // Silent, for the same reason as the unknown-address branch: telling the
      // caller they are rate limited confirms the address exists. The operator
      // sees it in the log.
      this.logger.warn(`password reset rate limit hit for ${user.email}`);
      return;
    }

    const token = AuthService.newToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.prisma.$transaction([
      // Supersede any outstanding link. Expiring rather than deleting keeps the
      // audit trail, and a superseded link then reads as expired - which it is.
      this.prisma.passwordReset.updateMany({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date() },
      }),
      this.prisma.passwordReset.create({
        data: {
          tokenHash: AuthService.hashToken(token),
          userId: user.id,
          expiresAt,
          userAgent: userAgent?.slice(0, 200),
        },
      }),
    ]);

    const appUrl = this.config.get('APP_URL', { infer: true });
    const url = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;

    // Awaited, not fire-and-forget: if the send fails the caller gets a 503 and
    // can try again, rather than being told to check an inbox that will stay
    // empty. The row is left in place - it simply expires unused.
    await this.mail.send(
      this.mail.passwordReset(
        user.email,
        user.name,
        url,
        Math.round(PASSWORD_RESET_TTL_MS / 60000),
      ),
    );
  }

  /**
   * Consume a reset token and set a new password. Revokes every session the user
   * has: the most likely reason for resetting a password is that someone else
   * knew the old one.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    AuthService.assertPasswordLength(newPassword);

    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: AuthService.hashToken(token) },
      include: { user: true },
    });

    // One message for all three failure modes. A distinct "already used" would
    // confirm to whoever found the link in a forwarded email that it was real.
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new BadRequestException(
        'This reset link is no longer valid. Request a new one.',
      );
    }

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.accessToken.deleteMany({
        where: { session: { userId: reset.userId } },
      }),
      this.prisma.session.updateMany({
        where: { userId: reset.userId },
        data: {
          revokedAt: new Date(),
          revokedReason: 'password-reset',
          refreshExpiresAt: new Date(),
        },
      }),
    ]);

    this.logger.log(`password reset completed for ${reset.user.email}`);
  }

  // -------------------------------------------------------------- accounts ----

  /** Operator path (CLI). Creates an ACTIVE account with any role - this is
   *  reachable only from a shell on the host, which is already full trust. */
  async createUser(input: {
    email: string;
    name: string;
    password: string;
    role: Role;
  }): Promise<SessionUser> {
    AuthService.assertPasswordLength(input.password);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        role: input.role,
        active: true,
        approvedAt: new Date(),
        passwordHash: await hashPassword(input.password),
      },
    });
    this.logger.log(`created ${user.role} ${user.email}`);
    return AuthService.toSessionUser(user);
  }

  /** Changing a password revokes every OTHER session for that user. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepAccessToken?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    AuthService.assertPasswordLength(newPassword);

    // Identified by the family of the access token in hand, so the tab doing the
    // change survives and every other device is logged out.
    const keep = keepAccessToken
      ? await this.prisma.accessToken.findUnique({
          where: { tokenHash: AuthService.hashToken(keepAccessToken) },
          select: { session: { select: { familyId: true } } },
        })
      : null;
    const keepFamilyId = keep?.session.familyId;

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      this.prisma.accessToken.deleteMany({
        where: {
          session: {
            userId,
            ...(keepFamilyId ? { familyId: { not: keepFamilyId } } : {}),
          },
        },
      }),
      this.prisma.session.updateMany({
        where: {
          userId,
          ...(keepFamilyId ? { familyId: { not: keepFamilyId } } : {}),
        },
        data: {
          revokedAt: new Date(),
          revokedReason: 'password-changed',
          refreshExpiresAt: new Date(),
        },
      }),
    ]);
  }

  private static toSessionUser(user: User): SessionUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  /** Constant-time string compare, exported for the rare non-hash comparison. */
  static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
