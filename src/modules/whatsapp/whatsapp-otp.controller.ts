import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { WhatsappOtpService } from './whatsapp-otp.service';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';

/**
 * Public — the campaign claim forms call these before submitting. Deliberately
 * unguarded, and deliberately rate-limited well below the global ceiling:
 * every request here costs a real WhatsApp message.
 */
@ApiExcludeController()
@Controller('whatsapp/otp')
export class WhatsappOtpController {
  constructor(private readonly otpService: WhatsappOtpService) {}

  // POST /api/whatsapp/otp/request
  @Post('request')
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  request(@Body() dto: RequestOtpDto) {
    return this.otpService.request(dto.phone);
  }

  // POST /api/whatsapp/otp/verify
  @Post('verify')
  @Throttle({ default: { limit: 15, ttl: 600_000 } })
  verify(@Body() dto: VerifyOtpDto) {
    return this.otpService.verify(dto.phone, dto.code);
  }
}
