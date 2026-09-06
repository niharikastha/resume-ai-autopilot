import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { resolveLlmProvider, type Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  // No global ValidationPipe: request validation is Zod, matching the LLM
  // boundary and config validation, rather than pulling in class-validator as a
  // second validation stack.
  app.enableShutdownHooks();

  // Session cookies are read by SessionGuard, so the parser has to be in place
  // before any guard runs.
  app.use(cookieParser());

  // The dashboard is a separate origin in dev. Localhost-only: this API is
  // never exposed publicly - on the server it is reached over an SSH tunnel.
  //
  // credentials:true is required for the session cookie to travel, and it is
  // exactly why the origin list is an allowlist of localhost rather than '*' -
  // the two are not allowed together, and should not be.
  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    credentials: true,
  });

  const env = {
    NODE_ENV: config.getOrThrow<string>('NODE_ENV'),
    LLM_PROVIDER: config.get<string>('LLM_PROVIDER'),
  } as Env;

  // Logged at boot so it is never ambiguous which provider produced a result.
  logger.log(`llm provider resolved to: ${resolveLlmProvider(env)}`);

  const port = config.getOrThrow<number>('PORT');
  // The host is not optional. `listen(port)` binds 0.0.0.0, which put this API on
  // every interface the machine has - so the CORS allowlist above was guarding a
  // door in a wall that was not there. CORS is a BROWSER policy: it stops a page
  // on another origin from reading responses, and does nothing about curl, or a
  // scanner on the same network, or the open internet on a VPS.
  //
  // Everything the plan says about this API - reached over an SSH tunnel, never
  // exposed - is only true if it refuses to accept a connection from anywhere but
  // this machine. That is what a loopback bind is.
  const host = '127.0.0.1';
  await app.listen(port, host);
  logger.log(`api listening on ${host}:${port}`);
}

void bootstrap();
