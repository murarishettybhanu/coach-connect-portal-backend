import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

@Controller('tracking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  // GET /api/tracking/:consignmentNumber — live India Post status via myspeedpost
  @Get(':consignmentNumber')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  track(@Param('consignmentNumber') consignmentNumber: string) {
    return this.trackingService.track(consignmentNumber);
  }
}
