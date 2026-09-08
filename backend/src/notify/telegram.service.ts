/**
 * The phone channel, if it is configured.
 *
 * OPTIONAL AND SILENT WHEN ABSENT, which is the opposite of MailService's behaviour and
 * deliberately so. Mail fails closed because a password reset that vanishes leaves
 * someone locked out waiting for it; a digest that was not Telegrammed is already
 * sitting in the app and, when SMTP is set up, already in an inbox. So an unconfigured
 * bot is a channel that is off, not an error - `configured` is false and nothing is
 * attempted.
 *
 * ONE CHAT ID, NOT ONE PER USER. TELEGRAM_CHAT_ID is a single operator-level setting
 * (PLAN-v2 phase 7 assumes one candidate with one phone), so this sends to whoever owns
 * that chat. That is fine while this is one person's machine and WRONG the moment a
 * second candidate signs up - so `notify.service.ts` uses this channel for ADMINS ONLY.
 * The operator owns the bot; another candidate's job list must not land on their phone,
 * and a per-user chat id is a settings screen nobody has asked for yet.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/** Telegram's own cap on a message body. Longer messages are rejected outright. */
const MAX_MESSAGE = 4096;

const TIMEOUT_MS = 15_000;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  get configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  private get token(): string | undefined {
    return this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  }

  private get chatId(): string | undefined {
    return this.config.get('TELEGRAM_CHAT_ID', { infer: true });
  }

  /**
   * Sends one message. Throws on failure so the caller can record why.
   *
   * Plain text, no parse_mode. Telegram's Markdown would need every `_`, `*`, `[` and
   * `.` in a job title escaped, and an unescaped one does not degrade - the API rejects
   * the whole message. A digest is not worth losing to a company called
   * `Acme_Systems*`.
   */
  async send(text: string): Promise<void> {
    const token = this.token;
    const chatId = this.chatId;
    if (!token || !chatId) {
      throw new Error(
        'Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)',
      );
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, MAX_MESSAGE),
          // The digest's only link is to the app. A preview card for it on every message
          // is noise on a phone.
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      // The body carries Telegram's own description ("chat not found", "bot was blocked
      // by the user"), which is the part that says what to do about it. The token is in
      // the URL and never in this message.
      const body = await response.text().catch(() => '');
      throw new Error(
        `Telegram HTTP ${response.status}: ${body.slice(0, 200).replace(/\s+/g, ' ')}`,
      );
    }

    this.logger.log('digest sent to Telegram');
  }
}
