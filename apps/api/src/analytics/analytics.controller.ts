import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { AnalyticsService } from './analytics.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WeeklyVolumeQueryDto } from './dto/weekly-volume-query.dto';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('weekly-volume')
  async weeklyVolume(@Req() req: AuthenticatedRequest, @Query() query: WeeklyVolumeQueryDto) {
    return this.analyticsService.weeklyVolume(req.userId, query.week);
  }
}
