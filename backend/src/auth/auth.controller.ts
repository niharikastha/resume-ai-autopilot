import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import {
  AuthService,
  RefreshRaceException,
  type TokenPair,
} from './auth.service';
import {
  ACCESS_COOKIE,
  CurrentUser,
  PASSWORD_MIN_LENGTH,
  Public,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  type SessionUser,
} from './auth.constants';

/**
 * Deliberately looser than z.email(): local accounts are addressed as
 * admin@localhost, which strict validation rejects for having no TLD. At these
 * endpoints the field is only a lookup key, so shape is all that needs checking -
 * and rejecting a valid local account at the form is a worse failure than
 * accepting a string that will simply not be found.
 */
const emailField = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Must look like an email address');

/**
 * The max is not cosmetic. The password goes into scrypt, whose cost scales with
 * input length, so an unbounded field is a cheap way to make the server do
 * expensive work.
 */
const passwordField = z.string().min(PASSWORD_MIN_LENGTH).max(400);

const loginBody = z.object({
  email: emailField,
  password: z.string().min(1).max(400),
});

const signupBody = z.object({
  email: emailField,
  name: z.string().trim().min(1).max(120),
  password: passwordField,
  // NOTE: there is no `role` here, and adding one would be a privilege
  // escalation. AuthService.signup does not accept a role at all.
});

const forgotPasswordBody = z.object({ email: emailField });

const resetPasswordBody = z.object({
  token: z.string().min(20).max(200),
  password: passwordField,
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(400),
  newPassword: passwordField,
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return result.data;
}

function cookie(req: Request, name: string): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[name];
}

/**
 * ONE MINUTE OF ARITHMETIC, in milliseconds, so the windows below read as time
 * rather than as five-digit constants.
 */
const MINUTES = 60_000;

/**
 * Every route here is rate limited; the numbers are per route and per IP.
 *
 * WHY THE GUARD IS ON THIS CONTROLLER AND NOT GLOBAL. These are the endpoints a
 * stranger can reach - three of them are @Public - and they are the ones where
 * repetition is the attack rather than the usage pattern. The rest of the API is
 * behind a session and its request rate is whatever the dashboard decides to poll
 * at, which is not something to cap from here.
 *
 * THE LIMITS ARE PER IP, WHICH IS BLUNT. A shared office NAT counts as one caller,
 * so these are set loose enough that a handful of people behind one address can
 * still sign in and mistype a password twice each. They exist to make automated
 * guessing expensive, not to enforce a usage policy - and the enumeration-safe
 * login and the approval queue are what actually protect the accounts.
 */
@Controller('api/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Cookie flags, and why each one:
   *   httpOnly  - script cannot read it, so an XSS in the dashboard does not
   *               yield the session. This is why no token goes to localStorage.
   *   sameSite  - COOKIE_SAMESITE, 'lax' by default. localhost:3200 and
   *               localhost:3100 are the same site (ports are not part of
   *               "site"), and so are two subdomains of one domain, so 'lax'
   *               covers both dev and a same-domain deployment. 'none' is for a
   *               genuinely cross-site front end and is opt-in - see the
   *               variable's own note for what it gives up.
   *   secure    - in production, and ALSO whenever sameSite is 'none', because
   *               the browser rejects that combination outright otherwise. Off in
   *               dev over plain http, where setting it would silently drop the
   *               cookie and look like a login bug.
   *
   * Read per call rather than cached in a field: these are flags on a response,
   * and a value read at construction time is one that cannot be corrected without
   * a restart for no gain worth the confusion.
   */
  private cookieOptions(path: string, expiresAt?: Date): CookieOptions {
    const sameSite = this.config.get<'lax' | 'none' | 'strict'>(
      'COOKIE_SAMESITE',
    );
    return {
      httpOnly: true,
      sameSite: sameSite ?? 'lax',
      secure:
        this.config.get<string>('NODE_ENV') === 'production' ||
        sameSite === 'none',
      path,
      ...(expiresAt ? { expires: expiresAt } : {}),
    };
  }

  /**
   * Both cookies, set together, always. They are issued as a pair and a response
   * that sets one without the other leaves the browser in a state neither
   * endpoint expects.
   */
  private setAuthCookies(res: Response, pair: TokenPair): void {
    res.cookie(
      ACCESS_COOKIE,
      pair.accessToken,
      this.cookieOptions('/', pair.accessExpiresAt),
    );
    res.cookie(
      REFRESH_COOKIE,
      pair.refreshToken,
      this.cookieOptions(REFRESH_COOKIE_PATH, pair.refreshExpiresAt),
    );
  }

  /** The path must match what was used to set it, or the browser keeps the
   *  cookie and the user stays signed in after clicking Sign out. */
  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, this.cookieOptions('/'));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions(REFRESH_COOKIE_PATH));
  }

  /**
   * 10 attempts per 5 minutes. Password guessing is the whole threat here, and the
   * cost of the limit falling on a legitimate user is that they wait five minutes
   * after ten wrong tries - by which point the password is not the one they think
   * it is and the reset link is the faster route anyway.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTES } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUser }> {
    const { email, password } = parse(loginBody, body);
    const pair = await this.auth.login(
      email,
      password,
      req.headers['user-agent'],
    );
    this.setAuthCookies(res, pair);
    return { user: pair.user };
  }

  /**
   * Open signup, with approval. Always 202 with the same body - see
   * AuthService.signup for why a duplicate address is not reported.
   */
  /**
   * 5 per hour. Signup is open to anyone, so this is the endpoint that decides how
   * much junk an administrator has to read: without a limit, one script can fill
   * the approval queue with a thousand rows and the pending count at the top of the
   * Accounts screen stops being information. Nobody legitimately creates a sixth
   * account from one address in an hour.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MINUTES } })
  @Post('signup')
  @HttpCode(202)
  async signup(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ status: 'pending'; message: string }> {
    const { email, name, password } = parse(signupBody, body);
    await this.auth.signup({
      email,
      name,
      password,
      userAgent: req.headers['user-agent'],
    });
    return {
      status: 'pending',
      message:
        'Thanks - your request is in. An administrator reviews new accounts before they can sign in, and you will get an email once yours is approved.',
    };
  }

  /**
   * Exchange the refresh cookie for a new pair.
   *
   * @Public because by definition the access cookie has expired by the time a
   * client calls this. The refresh cookie IS the credential here, so this is not
   * an unauthenticated endpoint in any meaningful sense.
   *
   * NOT THROTTLED. The credential is a high-entropy token, so there is nothing here
   * to guess, and the call rate is set by the client: every open tab refreshes on
   * its own 15-minute expiry, and a browser left open on six panels overnight would
   * trip a per-IP minute limit that had no attack to stop. Token REPLAY is handled
   * where it belongs - theft detection in AuthService revokes the session family.
   */
  @Public()
  @SkipThrottle()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUser }> {
    const token = cookie(req, REFRESH_COOKIE);
    if (!token) {
      // Clear the access cookie too: no refresh cookie means this browser cannot
      // get back in, so leaving a stale access cookie only produces a client
      // that keeps trying.
      this.clearAuthCookies(res);
      throw new BadRequestException('No session to refresh');
    }
    try {
      const pair = await this.auth.refresh(token, req.headers['user-agent']);
      this.setAuthCookies(res, pair);
      return { user: pair.user };
    } catch (err) {
      // Do NOT clear cookies on a benign two-tab race - the winner has just
      // written a good refresh cookie and clearing it here would turn a
      // recoverable retry into a logout. Any other failure is terminal.
      if (!(err instanceof RefreshRaceException)) {
        this.clearAuthCookies(res);
      }
      throw err;
    }
  }

  /**
   * 10 per hour PER IP, on top of the 5 per hour per address AuthService already
   * enforces. The two limits stop different things: the per-address cap stops one
   * mailbox being flooded, and this stops one caller walking a list of a thousand
   * addresses to find which ones bounce. Neither is redundant.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60 * MINUTES } })
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ status: 'sent'; message: string }> {
    const { email } = parse(forgotPasswordBody, body);
    await this.auth.requestPasswordReset(email, req.headers['user-agent']);
    return {
      status: 'sent',
      // Phrased to be true either way. Confirming that the address has an
      // account would make this endpoint a user enumeration oracle.
      message:
        'If that address has an account, a reset link is on its way. It expires in an hour.',
    };
  }

  /**
   * 10 per hour. The token is high-entropy and single-use, so guessing it is not
   * the realistic threat - but this endpoint is reachable without a session and
   * does password hashing work on every call, which makes an unlimited one a free
   * way to spend the server's CPU.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60 * MINUTES } })
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { token, password } = parse(resetPasswordBody, body);
    await this.auth.resetPassword(token, password);
    // The reset revoked every session, including whatever cookies this browser
    // is holding. Clearing them keeps the client from making requests with
    // credentials the server has already thrown away.
    this.clearAuthCookies(res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(
      cookie(req, REFRESH_COOKIE),
      cookie(req, ACCESS_COOKIE),
    );
    this.clearAuthCookies(res);
  }

  /**
   * The frontend's single source of truth for who it is talking to.
   *
   * NOT THROTTLED: it is behind the session guard, it reads no database row the
   * guard has not already read, and the dashboard asks for it on every mount. A
   * limit here would be a cap on how many pages a signed-in user may open.
   */
  @Get('me')
  @SkipThrottle()
  me(@CurrentUser() user: SessionUser): { user: SessionUser } {
    return { user };
  }

  /**
   * 10 per 5 minutes, the same shape as login and for the same reason: it takes
   * the CURRENT password, so it is a second place a password can be guessed. That
   * the caller already holds a session narrows who can try, and does not make the
   * guessing any more expensive.
   */
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTES } })
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const { currentPassword, newPassword } = parse(changePasswordBody, body);
    await this.auth.changePassword(
      user.id,
      currentPassword,
      newPassword,
      cookie(req, ACCESS_COOKIE),
    );
  }
}
