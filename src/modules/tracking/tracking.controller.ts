import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request as ExpressRequest } from 'express';
import { TrackingService, type TrackingCaller } from './tracking.service';
import { TrackBulkDto } from './dto/track-bulk.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

/**
 * Throttle key for the bulk route: the signed-in user rather than the IP, so
 * one account can't fan out across addresses (and an office behind one NAT
 * doesn't share a budget). The throttler runs before JwtAuthGuard, so this
 * reads `sub` from the bearer token unverified — harmless, since a forged
 * token is refused by the auth guard right after and never reaches India Post.
 */
export function trackerForUser(req: ExpressRequest): string {
  const token = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'),
    ) as { sub?: unknown };
    if (typeof payload.sub === 'string' && payload.sub) {
      return `user:${payload.sub}`;
    }
  } catch {
    // Not a JWT — fall back to the address.
  }
  return `ip:${req.ip}`;
}

@Controller('tracking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  // POST /api/tracking/bulk — up to 500 article numbers in one round trip.
  // Declared before the :consignmentNumber route so "bulk" isn't swallowed by it.
  // Each call can be 500 upstream lookups, so it gets a far smaller budget
  // than the global per-IP ceiling, counted per user.
  @Post('bulk')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
      getTracker: (req) => trackerForUser(req as ExpressRequest),
    },
  })
  trackBulk(
    @Body() dto: TrackBulkDto,
    @Request() req: { user: TrackingCaller },
  ) {
    return this.trackingService.trackManyFor(req.user, dto.consignmentNumbers);
  }

  // GET /api/tracking/:consignmentNumber — live status from India Post
  @Get(':consignmentNumber')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  track(
    @Param('consignmentNumber') consignmentNumber: string,
    @Request() req: { user: TrackingCaller },
  ) {
    return this.trackingService.trackFor(req.user, consignmentNumber);
  }
}
