import { Module } from '@nestjs/common';
import { AdminController, MeController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [AdminController, MeController],
  providers: [DashboardService],
})
export class DashboardModule {}
