import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { WhatsappService } from './whatsapp.service';
import type { WhatsappWebhookPayload } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

/**
 * Public webhook for the WhatsApp Cloud API. This is the URL handed to Meta:
 *
 *   https://api.tribemerchandise.com/api/whatsapp/webhook
 *
 * Deliberately unguarded — Meta sends no auth header. Authenticity comes from
 * the `X-Hub-Signature-256` HMAC, checked on every POST.
 */
@ApiExcludeController()
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // GET /api/whatsapp/webhook — Meta's one-time subscription handshake.
  // The challenge must come back as bare text, not JSON.
  @Get('webhook')
  @SkipThrottle()
  @Header('Content-Type', 'text/plain')
  verify(@Query() query: Record<string, string>): string {
    return this.whatsappService.verifySubscription(query);
  }

  // POST /api/whatsapp/webhook — inbound messages and delivery statuses.
  // Throttling is skipped: a burst of customer messages is not abuse, and a 429
  // would make Meta retry the batch and eventually disable the webhook.
  @Post('webhook')
  @SkipThrottle()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: WhatsappWebhookPayload,
  ) {
    this.whatsappService.assertValidSignature(req.rawBody, signature);
    await this.whatsappService.handleEvent(body);
    // Meta only reads the status code; the body is for our own curl checks.
    return { received: true };
  }
}

/** Admin-only read side, for eyeballing what has come in. */
@Controller('whatsapp/messages')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsappMessagesController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // GET /api/whatsapp/messages?from=919876543210&limit=50
  @Get()
  @Roles(UserRole.ADMIN)
  list(@Query('from') from?: string, @Query('limit') limit?: string) {
    return this.whatsappService.list(from, Number(limit) || 50);
  }
}
