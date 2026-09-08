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
   */
  RESUME_OUTPUT_DIR: blank(z.string().default('.artifacts/resumes')),

  /**
   * Where resumes UPLOADED through the web app are kept.
   *
   * Separate from RESUME_OUTPUT_DIR because the two have opposite lifecycles: the
   * output directory is regenerable at any time from the atoms, while a file in
   * here is the original the atoms were parsed from and cannot be reconstructed
   * if it is deleted. Mixing them invites a "clear the old tailored resumes"
   * cleanup that also removes every candidate's source document.
   *
   * Under .artifacts/ so the existing .gitignore rule covers it. These files are
   * whole resumes - name, phone, address, employment history - and must never
   * reach the repository.
   */
  RESUME_UPLOAD_DIR: blank(z.string().default('.artifacts/uploads')),

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

export type Env = z.infer<typeof envSchema>;

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
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
