import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
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
  async booking(@Param('token') token: string, @Body() body: unknown) {
    if (!this.webhook.tokenMatches(token)) throw new NotFoundException();
    return { success: true, ...(await this.webhook.ingest(body, 'BOOKING')) };
  }

  @Post(':token/events')
  @HttpCode(200)
  async events(@Param('token') token: string, @Body() body: unknown) {
    if (!this.webhook.tokenMatches(token)) throw new NotFoundException();
    return { success: true, ...(await this.webhook.ingest(body, 'OTHER')) };
  }
}
