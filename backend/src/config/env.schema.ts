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
