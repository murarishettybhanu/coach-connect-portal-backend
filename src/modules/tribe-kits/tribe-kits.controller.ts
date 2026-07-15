import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { TribeKitsService } from './tribe-kits.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

// Tribe kits are authored by admin (in the coach detail page) and read by both
// admin and the owning coach (for campaign selection).
@Controller('tribe-kits')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TribeKitsController {
  constructor(
    private readonly kits: TribeKitsService,
    private readonly tribesService: TribesService,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() body: any) {
    return this.kits.create(body);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async list(@Query('coachId') coachId: string, @Request() req: any) {
    // A coach may only ever see their own kits, regardless of the query param.
    if (req.user.role === UserRole.TRIBE) {
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      return this.kits.findByCoach(coach._id);
    }
    return this.kits.findByCoach(coachId);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() body: any) {
    return this.kits.update(id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.kits.remove(id);
  }
}
