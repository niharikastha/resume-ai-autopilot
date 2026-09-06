import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Worker entrypoint. Runs the same DI container as the api but without an HTTP
 * listener, so BullMQ processors and the cron scheduler live here.
 *
 * Separate from main.ts on purpose: the api can be restarted without
 * interrupting an in-flight pipeline run.
 */
/**
 * Marks this process as the worker, which is how scheduled jobs know to actually
 * run. AppModule is shared with main.ts, so every @Cron in the tree is registered
 * in BOTH processes; without a flag they would each fire.
 *
 * Set here rather than in the npm scripts so it holds however the worker is
 * started - `npm run dev:worker`, `node dist/src/worker`, or pm2 - with nothing
 * to remember and nothing to keep in sync.
 */
process.env.AUTOPILOT_ROLE = 'worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('worker').log('worker started');
}

void bootstrap();
