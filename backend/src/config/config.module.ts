import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Read from the repo root so one .env serves the whole workspace, the
      // same arrangement as merqube-hyally-platform.
      envFilePath: ['../.env', '.env'],
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
