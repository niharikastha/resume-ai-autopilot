import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import {
  allowedOrigins,
  resolveLlmProvider,
  type Env,
} from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  // No global ValidationPipe: request validation is Zod, matching the LLM
  // boundary and config validation, rather than pulling in class-validator as a
  // second validation stack.
  app.enableShutdownHooks();

  // Session cookies are read by SessionGuard, so the parser has to be in place
  // before any guard runs.
  app.use(cookieParser());

  // How many proxies are in front, so `req.ip` is the caller rather than the
  // proxy. Rate limiting keys on that value, so a wrong number here does not
  // break anything visibly - it quietly makes the auth throttle either useless
  // (every caller spoofing its own IP) or indiscriminate (every caller sharing
  // the proxy's). See TRUST_PROXY in env.schema.ts. Zero means "nothing in
  // front", which is the dev case and the SSH-tunnel case.
  const trustProxy = config.getOrThrow<number>('TRUST_PROXY');
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // The dashboard is a separate ORIGIN whenever it is not path-routed behind this
  // same host - always in dev (:3200 vs :3100), and in production if the front end
  // is deployed somewhere else, a Vercel project being the usual reason.
  //
  // credentials:true is required for the session cookie to travel, and it is
  // exactly why the origin list is an allowlist rather than '*' - the two are not
  // allowed together, and should not be. The list comes from APP_URL plus
  // CORS_EXTRA_ORIGINS, so the deployed origin is never a hardcoded constant that
  // someone has to remember to edit.
  const origins = allowedOrigins({
    NODE_ENV: config.getOrThrow<Env['NODE_ENV']>('NODE_ENV'),
    APP_URL: config.getOrThrow<string>('APP_URL'),
    CORS_EXTRA_ORIGINS: config.getOrThrow<string[]>('CORS_EXTRA_ORIGINS'),
  });
  app.enableCors({ origin: origins, credentials: true });
  logger.log(
    `cors allows: ${origins.map((o) => String(o)).join(', ')} (credentials)`,
  );

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
