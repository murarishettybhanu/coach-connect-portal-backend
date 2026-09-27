import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackBulkDto } from './dto/track-bulk.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

@Controller('tracking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  // POST /api/tracking/bulk — up to 500 article numbers in one round trip.
  // Declared before the :consignmentNumber route so "bulk" isn't swallowed by it.
  @Post('bulk')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  trackBulk(@Body() dto: TrackBulkDto) {
    return this.trackingService.trackMany(dto.consignmentNumbers);
  }

  // GET /api/tracking/:consignmentNumber — live status from India Post
  @Get(':consignmentNumber')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  track(@Param('consignmentNumber') consignmentNumber: string) {
    return this.trackingService.track(consignmentNumber);
  }
}
