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
  getProfile(@Request() req) {
    return this.tribesService.findByUserId(req.user._id);
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
  async update(@Param('id') id: string, @Body() tribeData: any, @Request() req) {
    if (req.user.role !== UserRole.ADMIN) {
      // A tribe may only edit its OWN record, and not privileged fields.
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      if (String(coach._id) !== String(id)) {
        throw new ForbiddenException('Not authorized to update this tribe');
      }
      delete tribeData.walletBalance;
      delete tribeData.isActive;
      delete tribeData.userId;
      delete tribeData.username;
      // Login identity (name/email) is admin-managed only.
      delete tribeData.email;
      delete tribeData.name;
    }
    return this.tribesService.update(id, tribeData);
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
