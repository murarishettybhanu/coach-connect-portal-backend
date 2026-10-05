import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../schemas/user.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

// The tribe dashboard. The tribe is always the caller's own (from the
// session), never from the request.
@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TRIBE)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('tribe')
  async tribe(
    @CurrentUserId() userId: string,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.analytics.tribe(
      await this.analytics.tribeIdForUser(userId),
      query,
    );
  }
}
