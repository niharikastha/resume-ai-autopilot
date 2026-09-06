import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Env } from '../config/env.schema';

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outbound email.
 *
 * FAILS CLOSED, and fails EARLY. If SMTP is not configured, `assertConfigured()`
 * throws a 503 before the caller has done anything - it does not log a warning
 * and return as though the mail went out. A password reset that silently drops
 * the message is worse than one that plainly says it is unavailable: the user
 * waits for an email that was never sent, and nothing anywhere records why.
 *
 * Note that "SMTP is unconfigured" is a property of the SERVER, not of the
 * address being asked about, so surfacing it to an anonymous caller leaks
 * nothing about who has an account here. That is why the check happens up front
 * rather than after the user lookup - see AuthService.requestPasswordReset.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Which required SMTP settings are absent. Empty means mail can be sent. */
  private missing(): string[] {
    const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
    return required.filter((key) => !this.config.get(key, { infer: true }));
  }

  get configured(): boolean {
    return this.missing().length === 0;
  }

  /**
   * Throw unless mail can actually be delivered. Call this BEFORE doing any work
   * whose only purpose is to produce an email.
   */
  assertConfigured(): void {
    const missing = this.missing();
    if (missing.length === 0) return;
    // The message names the missing variables because the person who sees it is
    // the operator running this stack, and "email is not configured" without
    // saying what is absent just means they go and read this file anyway.
    throw new ServiceUnavailableException(
      `Email is not configured on the server, so this cannot be sent. Missing: ${missing.join(', ')}.`,
    );
  }

  /**
   * The From header, and it must never come out blank.
   *
   * `??` is wrong here: `MAIL_FROM=` in a .env file is the empty STRING, not
   * undefined, so `??` accepts it and nodemailer then sends a message with no
   * From header at all. That is not a cosmetic problem - a null envelope sender
   * is rejected outright by most providers and treated as spam by the rest, so
   * the failure surfaces as "reset emails vanish" rather than as a config error.
   */
  private get from(): string {
    const candidates = [
      this.config.get('MAIL_FROM', { infer: true }),
      this.config.get('SMTP_USER', { infer: true }),
    ];
    return (
      candidates.find((v) => typeof v === 'string' && v.trim().length > 0) ??
      'autopilot@localhost'
    );
  }

  /** Built once and reused - nodemailer pools connections, and rebuilding the
   *  transport per message means a fresh TLS handshake for every email. */
  private transport(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = createTransport({
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: this.config.get('SMTP_SECURE', { infer: true }),
      auth: {
        user: this.config.get('SMTP_USER', { infer: true }),
        pass: this.config.get('SMTP_PASSWORD', { infer: true }),
      },
    });
    return this.transporter;
  }

  async send(mail: Mail): Promise<void> {
    this.assertConfigured();
    try {
      const info = await this.transport().sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      // The recipient is logged; the body is not. A password reset body contains
      // a working credential and logs are the one place people paste freely.
      this.logger.log(
        `sent "${mail.subject}" to ${mail.to} (${info.messageId})`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `failed to send "${mail.subject}" to ${mail.to}: ${reason}`,
      );
      // Rethrown, not swallowed. The caller decides what the user is told; what
      // it must not do is report success for a message that did not leave.
      throw new ServiceUnavailableException(
        'The email could not be sent. Please try again shortly.',
      );
    }
  }

  passwordReset(
    to: string,
    name: string,
    url: string,
    ttlMinutes: number,
  ): Mail {
    const subject = 'Reset your AUTOPILOT password';
    return {
      to,
      subject,
      text: [
        `Hi ${name},`,
        '',
        'Use this link to choose a new AUTOPILOT password:',
        url,
        '',
        `The link works once and expires in ${ttlMinutes} minutes.`,
        '',
        'If you did not ask for this, you can ignore this email. Your password',
        'has not changed and nobody has been told whether this address has an',
        'account.',
      ].join('\n'),
      html: layout(
        'Reset your password',
        `<p>Hi ${escapeHtml(name)},</p>
         <p>Use this link to choose a new AUTOPILOT password.</p>
         <p><a class="btn" href="${escapeHtml(url)}">Choose a new password</a></p>
         <p class="muted">The link works once and expires in ${ttlMinutes} minutes.</p>
         <p class="muted">If you did not ask for this you can ignore this email &mdash;
         your password has not changed.</p>`,
      ),
    };
  }

  accountApproved(to: string, name: string, url: string): Mail {
    return {
      to,
      subject: 'Your AUTOPILOT account is ready',
      text: [
        `Hi ${name},`,
        '',
        'An administrator has approved your AUTOPILOT account. You can sign in now:',
        url,
      ].join('\n'),
      html: layout(
        'Your account is ready',
        `<p>Hi ${escapeHtml(name)},</p>
         <p>An administrator has approved your AUTOPILOT account.</p>
         <p><a class="btn" href="${escapeHtml(url)}">Sign in</a></p>`,
      ),
    };
  }
}

/** `&` first, or it would double-escape the entities added after it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline styles only, and a table-free single column. Email clients strip <style>
 * blocks and have no CSS grid; anything cleverer than this renders as a mess in
 * Outlook.
 */
function layout(heading: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
    <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#71717a;margin-bottom:8px;">Autopilot</div>
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(heading)}</h1>
    <div style="font-size:14px;line-height:1.6;">
      ${body
        .replace(
          /class="btn"/g,
          'style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;"',
        )
        .replace(/class="muted"/g, 'style="color:#71717a;font-size:13px;"')}
    </div>
  </div>
</body></html>`;
}
