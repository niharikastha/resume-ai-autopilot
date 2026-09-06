import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Role } from '@prisma/client';

/**
 * Two cookies, two jobs.
 *
 * The ACCESS cookie is sent on every API request and is short-lived, so a copy
 * that leaks is worth very little for very long. The REFRESH cookie is
 * long-lived but scoped to `/api/auth` (see REFRESH_COOKIE_PATH), so the browser
 * does not attach it to the hundreds of ordinary requests that have no business
 * seeing it. Splitting them is the entire point: neither cookie is both
 * long-lived and widely sent.
 */
export const ACCESS_COOKIE = 'autopilot_access';
export const REFRESH_COOKIE = 'autopilot_refresh';

/**
 * The refresh cookie only ever needs to reach the auth controller. A path scope
 * is not a security boundary on its own - it is a blast-radius reduction, which
 * is worth having for free.
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

/** 15 minutes. This is the window in which a stolen access cookie still works,
 *  and the interval at which a live tab silently refreshes. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;

/** 14 days of INACTIVITY. Slides forward on every refresh, so an account in
 *  daily use is never logged out by this. */
export const REFRESH_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 90 days from first login, and no rotation extends it. Without a hard ceiling a
 * sliding window is effectively permanent - one refresh every fortnight, forever
 * - which means a session obtained today never has to be re-authenticated.
 */
export const REFRESH_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Grace window for a refresh token that has already been rotated.
 *
 * Two browser tabs waking up together both present the same refresh cookie; one
 * rotates it first and the loser is left holding a spent token through no fault
 * of anyone. Treating that as a replay attack would log people out for using two
 * tabs. So inside this window the request is refused WITHOUT revoking the family
 * - the winner has already written the new cookie into the jar that both tabs
 * share, so the loser's retry succeeds with it.
 *
 * Past this window there is no benign explanation left: a token rotated an hour
 * ago is being presented by someone who kept a copy. That revokes the family.
 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

/** 1 hour. A password reset link is a bearer credential sitting in an inbox. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Password resets requested per account per hour before we stop sending. Stops
 *  this endpoint being used to mailbomb someone via our SMTP credentials. */
export const PASSWORD_RESET_MAX_PER_HOUR = 5;

/** The floor, in characters. Length is the only rule - see AuthService. */
export const PASSWORD_MIN_LENGTH = 12;

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

/**
 * Opt a route OUT of authentication.
 *
 * The SessionGuard is registered globally, so the default is deny and a new
 * route is protected by forgetting rather than by remembering. Only login and
 * health should carry this.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/**
 * Restrict a route to specific roles. THIS is the access control - the frontend
 * hiding a nav link is ergonomics (PLAN-v2 2A.1).
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** The authenticated user, read from the server-side session - never from
 *  anything the client can set. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest<{ user?: SessionUser }>();
    if (!req.user) {
      // Unreachable behind the guard; thrown rather than returned so a future
      // route that skips the guard fails loudly instead of getting undefined.
      throw new Error('CurrentUser used on a route without SessionGuard');
    }
    return req.user;
  },
);
