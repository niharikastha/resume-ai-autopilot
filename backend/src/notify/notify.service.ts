/**
 * Delivery. Builds nothing and decides nothing about the content - it takes a digest
 * that already exists and tries to put it in front of a person.
 *
 * THREE CHANNELS, RANKED BY WHAT HAPPENS WHEN THEY FAIL:
 *
 *   in-app    Cannot fail. It is the stored row, and it is written before this class is
 *             called at all. This is why the digest is never lost - every other channel
 *             is a copy of something that is already safe.
 *   email     Attempted when SMTP is configured. A failure is recorded on the row and
 *             swallowed, because the digest is already delivered in-app and taking the
 *             09:00 worker down over a refused SMTP connection is a worse outcome than
 *             a missing email.
 *   Telegram  Admins only, and only when a bot token and chat id exist. See
 *             telegram.service.ts for why it is not per-user.
 *
 * EVERY FAILURE IS RECORDED RATHER THAN LOGGED AND FORGOTTEN. "I never got the email"
 * has to be answerable months later by looking at the row, not by finding the worker's
 * stdout from that morning.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Env } from '../config/env.schema';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { DigestService, type BuiltDigest } from './digest.service';
import { digestHtml, digestSubject, digestText } from './digest.text';
import type { DigestPayload } from './digest.types';
import { TelegramService } from './telegram.service';

export interface DeliveryOutcome {
  email: 'sent' | 'skipped' | 'failed';
  telegram: 'sent' | 'skipped' | 'failed';
  /** Why a channel was skipped or failed, in words meant for a person. */
  notes: string[];
}

export interface SendOptions {
  /** The end of the window. The cron passes nothing; tests pass a fixed instant. */
  now?: Date;
  /**
   * Mail it even though this morning has been mailed already.
   *
   * Off by default so the 09:00 cron cannot send twice, and on for the "send it to me
   * now" button - somebody pressing that has asked for a second copy on purpose.
   */
  resend?: boolean;
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly mail: MailService,
    private readonly telegram: TelegramService,
    private readonly digests: DigestService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Build one candidate's digest and send it. The whole job, for one person.
   *
   * The 09:00 cron and `npm run cli -- digest` both call THIS, so what the CLI does is
   * what the cron does. A test path that differs from the scheduled path is a test that
   * proves the wrong thing.
   *
   * The role is read here rather than accepted as an argument, because it decides
   * whether the digest goes to the operator's Telegram - and no caller should be able to
   * change that by passing a different value.
   */
  async sendFor(
    userId: string,
    options: SendOptions = {},
  ): Promise<{ built: BuiltDigest; outcome: DeliveryOutcome }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });
    const built = await this.digests.build(userId, options.now);
    const outcome = await this.deliver(built.id, user, built.payload, {
      // The de-duplication the upsert alone cannot give: rebuilding this morning's row
      // is free, mailing it twice is not. Only an explicit resend overrides it.
      emailAlreadySent: built.alreadyEmailed && !options.resend,
    });
    return { built, outcome };
  }

  /**
   * Sends one built digest everywhere it should go.
   *
   * Never throws. The caller is a cron callback, and an unhandled rejection there takes
   * the whole worker down - losing tomorrow's digest as well as today's email.
   */
  async deliver(
    digestId: string,
    recipient: { id: string; email: string; name: string; role: Role },
    payload: DigestPayload,
    options: { emailAlreadySent?: boolean } = {},
  ): Promise<DeliveryOutcome> {
    const appUrl = this.config.get('APP_URL', { infer: true });
    const subject = digestSubject(payload);
    const text = digestText(payload, appUrl);
    const outcome: DeliveryOutcome = {
      email: 'skipped',
      telegram: 'skipped',
      notes: [],
    };

    if (options.emailAlreadySent) {
      outcome.notes.push(
        "email was skipped: this morning's digest has already been emailed, and " +
          'rebuilding it is not a reason to send it again',
      );
    } else if (!this.mail.configured) {
      // Named settings rather than "email is not configured", because the person reading
      // this is the operator and the next question is always which value is missing.
      outcome.notes.push(
        'email was skipped: SMTP_HOST, SMTP_USER and SMTP_PASSWORD are not all set',
      );
    } else {
      try {
        await this.mail.send(
          this.mail.dailyDigest(
            recipient.email,
            subject,
            text,
            digestHtml(payload, appUrl),
          ),
        );
        outcome.email = 'sent';
        await this.digests.recordDelivery(digestId, 'email', null);
      } catch (err) {
        const reason = message(err);
        outcome.email = 'failed';
        outcome.notes.push(`email failed: ${reason}`);
        await this.digests.recordDelivery(digestId, 'email', reason);
        this.logger.error(
          `digest email to ${recipient.email} failed: ${reason}`,
        );
      }
    }

    if (!this.telegram.configured) {
      outcome.notes.push(
        'Telegram was skipped: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set',
      );
    } else if (recipient.role !== Role.ADMIN) {
      // The chat id belongs to the operator, not to this candidate. Sending someone
      // else's shortlist to it would be a privacy leak dressed as a feature.
      outcome.notes.push(
        'Telegram was skipped: the configured chat belongs to the operator, so only ' +
          'admin digests go there',
      );
    } else {
      try {
        await this.telegram.send(text);
        outcome.telegram = 'sent';
        await this.digests.recordDelivery(digestId, 'telegram', null);
      } catch (err) {
        const reason = message(err);
        outcome.telegram = 'failed';
        outcome.notes.push(`Telegram failed: ${reason}`);
        await this.digests.recordDelivery(digestId, 'telegram', reason);
        this.logger.error(`digest Telegram message failed: ${reason}`);
      }
    }

    return outcome;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
