import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { TribesService } from './tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { TRIBE_EDITABLE, UpdateTribeDto } from './dto/update-tribe.dto';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';

@Controller('tribes')
export class TribesController {
  constructor(private readonly tribesService: TribesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() tribeData: any) {
    return this.tribesService.create(tribeData);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.tribesService.findAll();
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  getProfile(@CurrentUserId() userId: string) {
    return this.tribesService.findByUserId(userId);
  }

  @Get(':username')
  // Publicly accessible for storefronts
  findByUsername(@Param('username') username: string) {
    return this.tribesService.findByUsername(username);
  }

  @Get('id/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findOne(@Param('id') id: string) {
    return this.tribesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTribeDto,
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    let patch: UpdateTribeDto = dto;
    if (req.user.role !== UserRole.ADMIN) {
      // A tribe may only edit its OWN record, and not privileged fields —
      // login identity (name/email), username and isActive are admin-managed.
      const tribeId = await this.tribesService.findIdByUserId(userId);
      if (tribeId !== String(id)) {
        throw new ForbiddenException('Not authorized to update this tribe');
      }
      patch = {};
      for (const key of TRIBE_EDITABLE) {
        if (dto[key] !== undefined) (patch as any)[key] = dto[key];
      }
    }
    return this.tribesService.update(id, patch);
  }

  // Admin: set a new login password for a tribe's account.
  @Patch(':id/reset-password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async resetPassword(@Param('id') id: string, @Body('password') password: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    await this.tribesService.resetPassword(id, password);
    return { success: true };
  }
}
