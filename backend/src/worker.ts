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
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('worker').log('worker started');
}

void bootstrap();
