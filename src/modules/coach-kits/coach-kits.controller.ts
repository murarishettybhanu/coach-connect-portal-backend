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
import { CoachKitsService } from './coach-kits.service';
import { CoachesService } from '../coaches/coaches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

// Coach kits are authored by admin (in the coach detail page) and read by both
// admin and the owning coach (for campaign selection).
@Controller('coach-kits')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CoachKitsController {
  constructor(
    private readonly kits: CoachKitsService,
    private readonly coachesService: CoachesService,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() body: any) {
    return this.kits.create(body);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COACH)
  async list(@Query('coachId') coachId: string, @Request() req: any) {
    // A coach may only ever see their own kits, regardless of the query param.
    if (req.user.role === UserRole.COACH) {
      const coach = await this.coachesService.findByUserId(
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
