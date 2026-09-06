import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import {
  ACCESS_COOKIE,
  IS_PUBLIC,
  REQUIRED_ROLES,
  type SessionUser,
} from './auth.constants';

/**
 * The access control for the whole API. Registered globally as APP_GUARD, so:
 *
 *   - every route requires a valid session unless marked @Public()
 *   - @Roles(ADMIN) routes reject a USER at the server
 *
 * Role comes from the session row. It is never read from the body, a header or a
 * query parameter - anything the client can set is not an authorization input
 * (PLAN-v2 2A.1).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: SessionUser }>();

    // The ACCESS cookie, never the refresh one. A refresh token must be usable
    // at exactly one endpoint - if it also authenticated ordinary requests, the
    // short access lifetime would buy nothing.
    const token = (req.cookies as Record<string, string> | undefined)?.[
      ACCESS_COOKIE
    ];
    if (!token) throw new UnauthorizedException('Not signed in');

    const user = await this.auth.resolveAccessToken(token);
    // The client reads this 401 as "try refreshing once", so it must stay a 401
    // and not become a 403 - see the api client's retry.
    if (!user) throw new UnauthorizedException('Session expired');

    req.user = user;

    const required = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.includes(user.role)) {
      // Deliberately not 404. A user who reaches an admin URL should be told
      // they lack access, not misled into thinking the route does not exist -
      // this API is not internet-facing, so route names are not a secret worth
      // protecting at the cost of a confusing error.
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
