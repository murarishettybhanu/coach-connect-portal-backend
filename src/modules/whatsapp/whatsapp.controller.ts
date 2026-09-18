import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { WhatsappService } from './whatsapp.service';
import { WhatsappApiService } from './whatsapp-api.service';
import { SendReplyDto } from './dto/send-reply.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { SendTemplateDto } from './dto/send-template.dto';
import { UpdateWhatsappSettingsDto } from './dto/update-settings.dto';
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

/**
 * Admin inbox — conversations, threads and replies. All admin-only; the public
 * webhook above is the only unguarded part of this module.
 */
@Controller('whatsapp')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsappAdminController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly api: WhatsappApiService,
  ) {}

  // GET /api/whatsapp/conversations — inbox list, most recently active first.
  @Get('conversations')
  @Roles(UserRole.ADMIN)
  listConversations() {
    return this.whatsappService.listConversations();
  }

  // GET /api/whatsapp/conversations/:contact — one thread, oldest first.
  @Get('conversations/:contact')
  @Roles(UserRole.ADMIN)
  getThread(@Param('contact') contact: string, @Query('limit') limit?: string) {
    return this.whatsappService.getThread(contact, Number(limit) || 200);
  }

  // POST /api/whatsapp/conversations/:contact/reply — free-form reply, only
  // valid inside the 24-hour window (400 with an explanation outside it).
  @Post('conversations/:contact/reply')
  @Roles(UserRole.ADMIN)
  reply(@Param('contact') contact: string, @Body() dto: SendReplyDto) {
    return this.whatsappService.replyTo(contact, dto.text);
  }

  // POST /api/whatsapp/conversations/:contact/template — approved template,
  // the only way to reach a customer once the 24-hour window has closed.
  @Post('conversations/:contact/template')
  @Roles(UserRole.ADMIN)
  sendTemplate(
    @Param('contact') contact: string,
    @Body() dto: SendTemplateDto,
  ) {
    return this.whatsappService.sendTemplateTo(contact, dto);
  }

  // GET /api/whatsapp/media/:mediaId — proxies inbound media, since Meta's URLs
  // expire in minutes and need the access token.
  @Get('media/:mediaId')
  @Roles(UserRole.ADMIN)
  async media(
    @Param('mediaId') mediaId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, mimeType } = await this.whatsappService.getMedia(mediaId);
    res.set({
      'Content-Type': mimeType,
      // Media is immutable once sent; cache privately in the admin's browser.
      'Cache-Control': 'private, max-age=86400',
    });
    return new StreamableFile(buffer);
  }

  // GET /api/whatsapp/settings — auto-reply text, business hours.
  @Get('settings')
  @Roles(UserRole.ADMIN)
  getSettings() {
    return this.whatsappService.getSettings();
  }

  // PATCH /api/whatsapp/settings
  @Patch('settings')
  @Roles(UserRole.ADMIN)
  updateSettings(@Body() dto: UpdateWhatsappSettingsDto) {
    return this.whatsappService.updateSettings(dto);
  }

  // PATCH /api/whatsapp/conversations/:contact/read — clears the unread badge.
  @Patch('conversations/:contact/read')
  @Roles(UserRole.ADMIN)
  markRead(@Param('contact') contact: string) {
    return this.whatsappService.markRead(contact);
  }

  // GET /api/whatsapp/messages?from=&limit= — flat feed across all senders.
  @Get('messages')
  @Roles(UserRole.ADMIN)
  listMessages(@Query('from') from?: string, @Query('limit') limit?: string) {
    return this.whatsappService.list(from, Number(limit) || 50);
  }

  // GET /api/whatsapp/templates — live from Meta, not cached locally, so the
  // review status shown is always current.
  @Get('templates')
  @Roles(UserRole.ADMIN)
  listTemplates() {
    return this.api.listTemplates();
  }

  // POST /api/whatsapp/templates — submits for review; comes back PENDING.
  @Post('templates')
  @Roles(UserRole.ADMIN)
  createTemplate(@Body() dto: CreateTemplateDto) {
    return this.api.createTemplate(dto);
  }

  // DELETE /api/whatsapp/templates/:name
  @Delete('templates/:name')
  @Roles(UserRole.ADMIN)
  async deleteTemplate(@Param('name') name: string) {
    await this.api.deleteTemplate(name);
    return { deleted: name };
  }
}
