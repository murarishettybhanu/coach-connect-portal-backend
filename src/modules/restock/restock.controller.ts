import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../schemas/user.schema';
import { RestockService } from './restock.service';
import {
  CreateRestockRequestDto,
  UpdateRestockRequestDto,
} from './dto/restock.dto';

// Tribe side. The tribe is always the caller's own (from the session), never
// from the request.
@Controller('restock')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TRIBE)
export class RestockController {
  constructor(private readonly restock: RestockService) {}

  @Get('overview')
  async overview(@CurrentUserId() userId: string) {
    return this.restock.overview(await this.restock.tribeIdForUser(userId));
  }

  @Post('requests')
  async create(
    @CurrentUserId() userId: string,
    @Body() dto: CreateRestockRequestDto,
  ) {
    return this.restock.createRequest(
      await this.restock.tribeIdForUser(userId),
      dto,
    );
  }

  @Get('requests/mine')
  async mine(@CurrentUserId() userId: string) {
    return this.restock.mine(await this.restock.tribeIdForUser(userId));
  }
}

// Admin review of restock requests.
@Controller('admin/restock')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminRestockController {
  constructor(private readonly restock: RestockService) {}

  @Get()
  list(@Query('status') status?: string, @Query('coachId') coachId?: string) {
    return this.restock.list({ status, coachId });
  }

  // Polled by every admin page: the unread badge + new-request pop-ups.
  @Get('unread')
  unread() {
    return this.restock.unread();
  }

  // Opening a request in the portal marks it read.
  @Patch(':id/seen')
  markSeen(@Param('id') id: string) {
    return this.restock.markSeen(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRestockRequestDto) {
    return this.restock.update(id, dto);
  }
}
