import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Public: a liveness probe that needs credentials is not a liveness probe.
  // It reveals only up/down, never data.
  @Public()
  @Get()
  async check(): Promise<{ status: string; postgres: boolean }> {
    let postgres = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      postgres = true;
    } catch {
      postgres = false;
    }
    return { status: postgres ? 'ok' : 'degraded', postgres };
  }
}
