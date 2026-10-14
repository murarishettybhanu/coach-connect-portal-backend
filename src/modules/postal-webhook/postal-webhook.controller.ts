import {
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Body,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { PostalSyncService } from './postal-sync.service';
import { PostalWebhookService } from './postal-webhook.service';

/**
 * India Post webhook URLs (set in their Customer Self-Service Portal):
 *   Booking events → POST /api/indiapost/webhook/:token/booking
 *   Other events   → POST /api/indiapost/webhook/:token/events
 * `:token` is INDIAPOST_WEBHOOK_TOKEN; a wrong or missing one is a 404, as if
 * the route didn't exist. Unthrottled — India Post sends bursts. Always 200
 * for a valid token, even for events we can't use, so they don't retry them.
 */
@Controller('indiapost/webhook')
@SkipThrottle()
export class PostalWebhookController {
  constructor(private readonly webhook: PostalWebhookService) {}

  @Post(':token/booking')
  @HttpCode(200)
  booking(@Param('token') token: string, @Req() req: Request) {
    return this.receive(token, req, 'BOOKING');
  }

  @Post(':token/events')
  @HttpCode(200)
  events(@Param('token') token: string, @Req() req: Request) {
    return this.receive(token, req, 'OTHER');
  }

  /**
   * The body was read by `postalBodyParser` (app.setup.ts): JSON whatever its
   * Content-Type, raw text kept on `req.postalRaw`. Every valid-token delivery
   * is logged, readable or not.
   */
  private async receive(
    token: string,
    req: Request,
    channel: 'BOOKING' | 'OTHER',
  ) {
    if (!this.webhook.tokenMatches(token)) throw new NotFoundException();
    const raw: string = (req as any).postalRaw ?? '';
    let result = { received: 0, stored: 0 };
    let error: string | undefined;
    try {
      result = await this.webhook.ingest(req.body, channel);
    } catch (err) {
      error = (err as Error).message;
    }
    await this.webhook.logDelivery({
      channel,
      contentType: String(req.headers['content-type'] ?? ''),
      bytes: Buffer.byteLength(raw),
      raw,
      ...result,
      ...(error ? { error } : {}),
    });
    return { success: true, ...result };
  }
}

/** Admin: "Sync with India Post" — see PostalSyncService. */
@Controller('indiapost')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class PostalSyncController {
  constructor(private readonly sync: PostalSyncService) {}

  @Post('sync')
  @HttpCode(200)
  // Each run can be thousands of upstream lookups.
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  run(
    @Body('coachId') coachId?: string,
    @Body('campaignId') campaignId?: string,
    // Preview: report what would change without writing or messaging anyone.
    @Body('dryRun') dryRun?: boolean,
  ) {
    return this.sync.sync({ coachId, campaignId, dryRun: dryRun === true });
  }
}
