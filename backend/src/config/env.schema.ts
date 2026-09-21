import { z } from 'zod';

/**
 * Treat `KEY=` as absent rather than as the empty string.
 *
 * dotenv reports a blank line as `''`, not `undefined`, so a schema default
 * never fires and a coerced number becomes 0. That turns commenting out a value
 * by emptying it - the obvious thing to do - into a boot failure complaining
 * that 587 is not a positive integer. Only needed on fields whose natural
 * resting state is blank.
 */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/**
 * Environment contract. Validated once at boot; a bad value stops the process
 * instead of surfacing as a confusing failure three modules downstream.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6380),

  PORT: z.coerce.number().int().positive().default(3100),

  // Phase 2. Optional here because phase 0 and 1 do not touch an LLM, but the
  // provider resolver below fails loudly if the selected provider's key is
  // missing at the point it is actually needed.
  LLM_PROVIDER: z.enum(['claude', 'gemini']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  /**
   * HOW to reach Claude. A separate question from LLM_PROVIDER, which picks WHICH
   * model family - the same Opus and Haiku are reachable either through Anthropic
   * directly or through AWS Bedrock, and only the credentials and the model ids
   * differ.
   *
   * Kept as its own variable rather than folded in as `LLM_PROVIDER=bedrock`
   * because the provider id is written into every MatchScore and ResumeVariant row.
   * Bedrock is not a different provider producing different answers; it is the same
   * model behind a different door, and a row that claimed otherwise would make
   * "why did the scores shift" harder to answer rather than easier.
   *
   * `api-key` by default, because that is the path with no AWS account in it.
   */
  CLAUDE_AUTH_MODE: blank(z.enum(['api-key', 'bedrock']).default('api-key')),

  /**
   * Bedrock credentials, used only when CLAUDE_AUTH_MODE=bedrock. All optional
   * here for the same reason ANTHROPIC_API_KEY is: discovery and profile ingestion
   * do not need them, and the app should not refuse to boot over an unset one.
   * ClaudeProvider fails at the first call instead, naming what is missing.
   *
   * Three ways to authenticate, tried in this order:
   *   1. AWS_BEARER_TOKEN_BEDROCK - a Bedrock API key from the AWS console. The
   *      simplest: one value, no SigV4, no IAM user.
   *   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN for a
   *      temporary role). Signed with SigV4.
   *   3. Neither, in which case the AWS credential provider chain resolves them -
   *      `~/.aws/credentials`, SSO, an instance role. This is the right answer on
   *      an EC2 host and the reason the keys are not required.
   *
   * AWS_REGION IS effectively required in bedrock mode, and is enforced at the
   * point of use rather than here - optional in this schema only because it must
   * not stop an api-key install from booting. It picks the endpoint host, and with
   * it which region's model access applies.
   */
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),

  /**
   * Bedrock model ids, overriding the `anthropic.`-prefixed defaults.
   *
   * Rarely needed: Bedrock takes the same model names behind that one prefix, so
   * ClaudeProvider can build the id rather than ask. These exist for the two things
   * a prefix cannot express - a provisioned-throughput ARN, and pinning a dated
   * snapshot in an account where the alias is not what has been granted.
   */
  BEDROCK_MODEL_FAST: z.string().optional(),
  BEDROCK_MODEL_DEEP: z.string().optional(),

  /**
   * Phase 5. Where tailored resumes are written.
   *
   * Relative paths resolve against the process cwd, which for `npm run cli` is
   * `backend/`. Defaulted rather than required because a missing output directory
   * should not stop the app booting, and because this is the kind of value that is
   * only ever set on the server.
   *
   * NOT under `backend/src`: these are generated artifacts containing the
   * candidate's real contact details, and the default therefore sits somewhere
   * .gitignore already covers.
   *
   * `generated-resumes/` at the root of that directory, so in practice
   * `backend/generated-resumes/`. It moved out of `.artifacts/` for the same
   * reason the uploads did: .artifacts is the scratch directory, and somebody
   * emptying it is entitled to assume nothing there mattered. These files DO
   * matter for as long as an application is open - the pdf sitting in a queued
   * application is the exact document that will be attached, and regenerating it
   * means another round of Opus calls and a fresh trip through the provenance
   * guard, which is not guaranteed to produce the same resume twice.
   *
   * The name is not `resumes/`: the ignore rules here are deliberately unanchored,
   * and an unanchored `resumes/` would also ignore
   * `frontend/src/app/app/resumes/`, which is source code.
   */
  RESUME_OUTPUT_DIR: blank(z.string().default('generated-resumes')),

  /**
   * Where resumes UPLOADED through the web app are kept.
   *
   * Separate from RESUME_OUTPUT_DIR because the two have opposite lifecycles: the
   * output directory is regenerable at any time from the atoms, while a file in
   * here is the original the atoms were parsed from and cannot be reconstructed
   * if it is deleted. Mixing them invites a "clear the old tailored resumes"
   * cleanup that also removes every candidate's source document.
   *
   * `uploads/` at the root of whatever directory the API was started from, which
   * in practice is `backend/uploads/`. NOT under .artifacts/, where it used to
   * live: .artifacts is the scratch directory, and a person clearing it out has
   * every reason to think nothing irreplaceable is in there. A separate top-level
   * name says what this is. `.gitignore` has its own `uploads/` rule, and it has
   * to stay - these files are whole resumes, name, phone, address and employment
   * history, and must never reach the repository.
   */
  RESUME_UPLOAD_DIR: blank(z.string().default('uploads')),

  /**
   * Phase 6. Chrome's profile directory for submission sessions.
   *
   * A REAL BROWSER PROFILE, with the candidate's logged-in sessions and Chrome's own
   * autofill in it. Treat it as credentials: `.gitignore` already excludes
   * `/.browser-profile/`, and it must not be moved somewhere that is not covered.
   *
   * Persistent on purpose - see browser.service.ts. A fresh profile every morning
   * would mean logging into each board again, and would discard the autofill history
   * the filling engine deliberately leaves alone.
   */
  BROWSER_PROFILE_DIR: blank(z.string().default('.browser-profile')),

  /**
   * Phase 6. Where the full-page screenshot of each prepared form is written.
   *
   * These images contain the candidate's contact details and whatever the form asked,
   * so the default sits under .artifacts/, which .gitignore covers. They are the audit
   * trail the plan's safety rails require: the evidence of what a form looked like at
   * the moment a human was asked to send it.
   */
  SUBMISSION_SHOT_DIR: blank(z.string().default('.artifacts/submissions')),

  // Phase 7.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Phase 1. Sent on every outbound job-board request so a site operator can
  // reach a human instead of silently blocking us.
  DISCOVERY_CONTACT_EMAIL: z.string().email().optional(),

  /**
   * Where the browser reaches the web app. Used to build absolute links in
   * outbound mail, which cannot be relative. Never derived from a request header
   * - Host and X-Forwarded-Host are attacker-controlled, and a password reset
   * link built from one is a way to have us mail the attacker's URL to the
   * victim from our own domain.
   */
  APP_URL: blank(z.string().url().default('http://localhost:3200')),

  /**
   * Extra browser origins allowed to call this API with credentials.
   *
   * APP_URL is always allowed, so this exists only for the case where the app is
   * reached at a URL other than the one that goes into mail - a Vercel project
   * that answers on both its generated domain and a custom one, or a staging
   * front end pointed at this API.
   *
   * Comma-separated EXACT origins, scheme and host and port. A credentialed CORS
   * response may not use `*` and must echo back one specific origin, which is why
   * this is a list rather than a pattern. Empty by default: an origin permitted to
   * read authenticated responses is a decision, not a convenience.
   */
  CORS_EXTRA_ORIGINS: blank(
    z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().replace(/\/$/, ''))
          .filter(Boolean),
      ),
  ),

  /**
   * SameSite on both session cookies.
   *
   * 'lax' is correct whenever the dashboard and this API are the same SITE, and
   * "site" is more forgiving than "origin": different ports are the same site
   * (localhost:3200 -> localhost:3100, which is why dev works), and so are
   * different subdomains of one registrable domain (app.example.com ->
   * api.example.com). Path-routing both behind one host is the same site too.
   *
   * 'none' is needed only when they are genuinely different sites - a front end on
   * *.vercel.app calling an API on your own domain. It is strictly weaker: the
   * cookie then rides along on cross-site requests, which is exactly the CSRF
   * protection 'lax' was providing for free. So it is opt-in, never inferred, and
   * the refinement below refuses the combination that silently does not work.
   */
  COOKIE_SAMESITE: blank(z.enum(['lax', 'none', 'strict']).default('lax')),

  /**
   * How many reverse proxies stand in front of this API.
   *
   * 0 means `req.ip` is the socket's peer, correct when nothing is in front.
   * Behind Caddy on the same host it is 1, and Express then reads the last entry
   * of X-Forwarded-For - the only one the proxy wrote itself.
   *
   * A COUNT, NOT A BOOLEAN. `trust proxy: true` trusts the entire header, and the
   * header is supplied by the caller: a client sending `X-Forwarded-For: 1.2.3.4`
   * would be rate-limited as 1.2.3.4 and could invent a fresh identity per
   * request, which is indistinguishable from having no rate limit at all. Getting
   * this number wrong in the other direction is safe but useless - every caller
   * shares the proxy's IP and the first burst locks out everyone.
   */
  TRUST_PROXY: blank(z.coerce.number().int().min(0).default(0)),

  // Outbound mail. Optional at boot, like the LLM keys: the whole app should not
  // refuse to start because password-reset email is unconfigured. MailService
  // fails closed at the point of use instead, and says which vars are missing.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: blank(z.coerce.number().int().positive().default(587)),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** True for implicit TLS on 465. Leave false for 587, which upgrades with
   *  STARTTLS - nodemailer does that automatically and it is not "insecure". */
  SMTP_SECURE: blank(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  ),
  /** The From header. Many providers reject a From that is not the authenticated
   *  mailbox, so this defaults to SMTP_USER rather than to something invented. */
  MAIL_FROM: z.string().optional(),
});

/** Is this a URL the browser treats as a secure context despite plain http? */
function isLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * The one cross-field rule: a Secure cookie needs somewhere secure to go.
 *
 * `secure` is set on both session cookies in production, and additionally whenever
 * SameSite is 'none' (the browser requires the pair). A Secure cookie sent to a
 * plain-http origin is DISCARDED SILENTLY - no error anywhere, the login response
 * is a 200, and the very next request is a 401. That failure looks like a bug in
 * the session code and is nothing of the kind, so it is worth refusing to boot over.
 *
 * localhost is exempt because browsers treat it as a secure context, which is what
 * makes the SSH-tunnel deployment in the README work: NODE_ENV=production, cookies
 * marked Secure, reached over http://localhost:3200, and correct.
 */
const secureCookieNeedsHttps = envSchema.superRefine((env, ctx) => {
  const cookiesWillBeSecure =
    env.NODE_ENV === 'production' || env.COOKIE_SAMESITE === 'none';
  if (!cookiesWillBeSecure) return;
  if (env.APP_URL.startsWith('https://') || isLocalhost(env.APP_URL)) return;

  ctx.addIssue({
    code: 'custom',
    path: ['APP_URL'],
    message:
      `is plain http on a public host (${env.APP_URL}), but session cookies ` +
      `will be marked Secure (NODE_ENV=${env.NODE_ENV}, ` +
      `COOKIE_SAMESITE=${env.COOKIE_SAMESITE}). The browser would discard them ` +
      `and every request after login would 401. Use https, or reach the app over ` +
      `localhost through a tunnel.`,
  });
});

export type Env = z.infer<typeof envSchema>;

/**
 * Browser origins allowed to call this API with credentials.
 *
 * APP_URL is where the app actually is, so it is always in. The localhost patterns
 * are added ONLY outside production: in dev the web app is on :3200 and the API on
 * :3100, two origins, and the alternative is making every developer set a variable
 * to get a working login. In production they would be a standing invitation to
 * anything running on the operator's own machine, for no benefit.
 *
 * A function rather than a schema field because it is derived, and a derived value
 * stored in config is a value that can disagree with the things it was derived from.
 */
export function allowedOrigins(
  env: Pick<Env, 'NODE_ENV' | 'APP_URL' | 'CORS_EXTRA_ORIGINS'>,
): (string | RegExp)[] {
  const origins: (string | RegExp)[] = [
    env.APP_URL.replace(/\/$/, ''),
    ...env.CORS_EXTRA_ORIGINS,
  ];
  if (env.NODE_ENV !== 'production') {
    origins.push(/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/);
  }
  return origins;
}

/**
 * Which LLM provider this process will use.
 *
 * LLM_PROVIDER wins if set. Otherwise gemini in production (free tier, so the
 * hosted daily run costs nothing) and claude everywhere else. Resolved once and
 * logged, so it is never ambiguous which provider produced a given result.
 */
export function resolveLlmProvider(env: Env): 'claude' | 'gemini' {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER;
  return env.NODE_ENV === 'production' ? 'gemini' : 'claude';
}

export function validateEnv(raw: Record<string, unknown>): Env {
  // The refined schema, not the bare object: the cookie/https rule is cross-field
  // and can only run after every individual value has a default applied.
  const parsed = secureCookieNeedsHttps.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
