import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Queue names. The pipeline is a chain of independently retryable stages, so a
 * connector failing at 09:00 does not force the whole day's run to be redone:
 *
 *   discover -> normalize -> filter -> embed -> score -> tailor -> prefill
 */
export const QUEUE = {
  DISCOVER: 'discover',
  NORMALIZE: 'normalize',
  FILTER: 'filter',
  EMBED: 'embed',
  SCORE: 'score',
  TAILOR: 'tailor',
  PREFILL: 'prefill',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Keep a window of history for the digest, but do not let completed
          // jobs accumulate in Redis indefinitely.
          removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
          removeOnFail: { age: 30 * 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(...Object.values(QUEUE).map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueueModule {}
