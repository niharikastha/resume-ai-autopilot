import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    // The pg driver adapter (rather than Prisma's default engine connection) is
    // what makes raw vector queries practical - $queryRaw goes over the same
    // pool as the rest of the client.
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();

    // Fail at boot, not at first query, if the extensions are missing. Without
    // `vector` every embedding write fails; without `pg_trgm` cross-source
    // dedupe silently degrades to exact matching, which is worse because it
    // looks like it works.
    const rows = await this.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')
    `;
    const present = new Set(rows.map((r) => r.extname));
    const missing = ['vector', 'pg_trgm'].filter((e) => !present.has(e));
    if (missing.length > 0) {
      throw new Error(
        `Postgres is missing required extension(s): ${missing.join(', ')}. ` +
          `Run \`npm run db:up\` with a clean volume, or CREATE EXTENSION manually.`,
      );
    }

    this.logger.log('Postgres connected (vector, pg_trgm present)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
