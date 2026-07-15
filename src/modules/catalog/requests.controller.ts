import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { QuoteRequestsService } from './quote-requests.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { RequestSource } from '../../schemas/quote-request.schema';
import { TribeQuoteDto, UpdateRequestDto } from './dto/quote-request.dto';

// Authenticated request surface: coaches raise quotes; admins review all.
@Controller('requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RequestsController {
  constructor(
    private readonly requests: QuoteRequestsService,
    private readonly tribesService: TribesService,
  ) {}

  @Post('quote')
  @Roles(UserRole.TRIBE)
  async createQuote(@Body() dto: TribeQuoteDto, @Request() req: any) {
    const coach = await this.tribesService.findByUserId(
      req.user.userId || req.user.sub || req.user._id,
    );
    return this.requests.createTribeQuote(coach, dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  list(@Query('source') source?: RequestSource) {
    return this.requests.list(source);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateRequestDto) {
    return this.requests.update(id, dto);
  }
}
