/**
 * Delivery, and the four ways it is allowed to go wrong.
 *
 *   1. IT NEVER THROWS. The caller is a cron callback at 09:00. An unhandled rejection
 *      there takes the worker down, which costs tomorrow's digest as well as today's
 *      email.
 *   2. IT NEVER SENDS THE SAME MORNING TWICE. The upsert keeps the row single; only this
 *      class keeps the mail single. Two identical emails at nine is how an address gets
 *      marked as spam.
 *   3. TELEGRAM IS ADMINS ONLY. There is one operator-level chat id, so sending a plain
 *      candidate's shortlist to it would be a privacy leak dressed as a feature.
 *   4. EVERY OUTCOME IS RECORDED ON THE ROW. "I never got the email" has to be
 *      answerable months later from the database, not from that morning's stdout.
 */
import { Role } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { BuiltDigest, DigestService } from './digest.service';
import { NotifyService } from './notify.service';
import type { TelegramService } from './telegram.service';
import type { DigestPayload } from './digest.types';

const PAYLOAD: DigestPayload = {
  version: 1,
  day: '2026-09-08',
  generatedAt: '2026-09-08T03:30:00.000Z',
  since: '2026-09-07T03:30:00.000Z',
  candidate: {
    newMatches: 9,
    byVerdict: { STRONG: 2 },
    undecided: 4,
    top: [],
    tailored: 0,
    guardFailed: 0,
    guardFailureRate: null,
    preparedWaiting: 1,
    submitted: 0,
    missingAnswers: [],
  },
  system: null,
};

class FakeMail {
  sent: { to: string; subject: string }[] = [];
  breaks = false;

  constructor(readonly configured: boolean) {}

  dailyDigest(to: string, subject: string, text: string, html: string) {
    return { to, subject, text, html };
  }

  send(mail: { to: string; subject: string }): Promise<void> {
    if (this.breaks)
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:587'));
    this.sent.push(mail);
    return Promise.resolve();
  }
}

class FakeTelegram {
  messages: string[] = [];
  breaks = false;

  constructor(readonly configured: boolean) {}

  send(text: string): Promise<void> {
    if (this.breaks)
      return Promise.reject(new Error('Telegram HTTP 400: chat not found'));
    this.messages.push(text);
    return Promise.resolve();
  }
}

class FakeDigests {
  readonly deliveries: { channel: string; error: string | null }[] = [];
  built = 0;

  constructor(private readonly alreadyEmailed = false) {}

  build(_userId: string): Promise<BuiltDigest> {
    this.built++;
    return Promise.resolve({
      id: 'digest-1',
      day: PAYLOAD.day,
      payload: PAYLOAD,
      alreadyEmailed: this.alreadyEmailed,
    });
  }

  recordDelivery(
    _id: string,
    channel: 'email' | 'telegram',
    error: string | null,
  ) {
    this.deliveries.push({ channel, error });
    return Promise.resolve();
  }
}

function make(
  options: {
    mail?: boolean;
    telegram?: boolean;
    role?: Role;
    alreadyEmailed?: boolean;
  } = {},
) {
  const mail = new FakeMail(options.mail ?? true);
  const telegram = new FakeTelegram(options.telegram ?? true);
  const digests = new FakeDigests(options.alreadyEmailed ?? false);
  const config = { get: () => 'http://localhost:3200' };
  const prisma = {
    user: {
      findUniqueOrThrow: () =>
        Promise.resolve({
          id: 'user-1',
          email: 'a@example.com',
          name: 'A',
          role: options.role ?? Role.ADMIN,
        }),
    },
  } as unknown as PrismaService;

  const service = new NotifyService(
    config as unknown as ConfigService<never, true>,
    mail as unknown as MailService,
    telegram as unknown as TelegramService,
    digests as unknown as DigestService,
    prisma,
  );
  return { service, mail, telegram, digests };
}

describe('NotifyService.sendFor', () => {
  it('builds and then delivers, in that order', async () => {
    const { service, mail, telegram, digests } = make();

    const { built, outcome } = await service.sendFor('user-1');

    expect(digests.built).toBe(1);
    expect(built.id).toBe('digest-1');
    expect(outcome).toEqual({ email: 'sent', telegram: 'sent', notes: [] });
    expect(mail.sent[0].subject).toContain('9 new matches');
    expect(telegram.messages[0]).toContain('AUTOPILOT - 2026-09-08');
  });

  it('does not mail a morning that has already been mailed', async () => {
    const { service, mail, digests } = make({ alreadyEmailed: true });

    const { outcome } = await service.sendFor('user-1');

    // The row is rebuilt - that is free and keeps the numbers current. The email is not
    // sent again, because a restarting worker would otherwise send it on every attempt.
    expect(digests.built).toBe(1);
    expect(mail.sent).toHaveLength(0);
    expect(outcome.email).toBe('skipped');
    expect(outcome.notes.join(' ')).toContain('already been emailed');
  });

  it('mails it again when a person asked for it', async () => {
    const { service, mail } = make({ alreadyEmailed: true });

    const { outcome } = await service.sendFor('user-1', { resend: true });

    // The "send it to me now" button. Pressing that is a deliberate request for a copy.
    expect(outcome.email).toBe('sent');
    expect(mail.sent).toHaveLength(1);
  });
});

describe('NotifyService.deliver', () => {
  const recipient = {
    id: 'user-1',
    email: 'a@example.com',
    name: 'A',
    role: Role.ADMIN,
  };

  it('names the settings that are missing rather than saying "not configured"', async () => {
    const { service } = make({ mail: false, telegram: false });

    const outcome = await service.deliver('digest-1', recipient, PAYLOAD);

    expect(outcome).toMatchObject({ email: 'skipped', telegram: 'skipped' });
    // The person reading this is the operator, and their next question is always which
    // value is missing.
    expect(outcome.notes[0]).toContain('SMTP_HOST');
    expect(outcome.notes[1]).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('keeps Telegram for admins even when it is configured', async () => {
    const { service, telegram } = make();

    const outcome = await service.deliver(
      'digest-1',
      { ...recipient, role: Role.USER },
      PAYLOAD,
    );

    // The chat belongs to the operator. Another candidate's job list must not arrive on
    // their phone.
    expect(telegram.messages).toHaveLength(0);
    expect(outcome.telegram).toBe('skipped');
    expect(outcome.notes.join(' ')).toContain('belongs to the operator');
  });

  it('survives a refused SMTP connection and records why', async () => {
    const { service, mail, digests } = make();
    mail.breaks = true;

    const outcome = await service.deliver('digest-1', recipient, PAYLOAD);

    // The digest is already delivered in-app; taking the 09:00 worker down over a mail
    // server would be the worse outcome.
    expect(outcome.email).toBe('failed');
    expect(outcome.notes.join(' ')).toContain('ECONNREFUSED');
    expect(digests.deliveries).toContainEqual({
      channel: 'email',
      error: 'connect ECONNREFUSED 127.0.0.1:587',
    });
    // One channel failing must not cost the other one.
    expect(outcome.telegram).toBe('sent');
  });

  it('survives a Telegram rejection and records why', async () => {
    const { service, telegram, digests } = make();
    telegram.breaks = true;

    const outcome = await service.deliver('digest-1', recipient, PAYLOAD);

    expect(outcome).toMatchObject({ email: 'sent', telegram: 'failed' });
    expect(digests.deliveries).toContainEqual({
      channel: 'telegram',
      error: 'Telegram HTTP 400: chat not found',
    });
  });

  it('records the successes too, so the row can answer "was I told?"', async () => {
    const { service, digests } = make();

    await service.deliver('digest-1', recipient, PAYLOAD);

    expect(digests.deliveries).toEqual([
      { channel: 'email', error: null },
      { channel: 'telegram', error: null },
    ]);
  });
});
