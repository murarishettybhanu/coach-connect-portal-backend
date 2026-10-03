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
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { CreateTribeKitDto, UpdateTribeKitDto } from './dto/tribe-kit.dto';

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
  create(@Body() body: CreateTribeKitDto) {
    return this.kits.create(body);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async list(
    @Query('coachId') coachId: string,
    @Request() req: any,
    @CurrentUserId() userId: string,
  ) {
    // A coach may only ever see their own kits, regardless of the query param.
    if (req.user.role === UserRole.TRIBE) {
      return this.kits.findByCoach(await this.tribesService.findIdByUserId(userId));
    }
    return this.kits.findByCoach(coachId);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateTribeKitDto) {
    return this.kits.update(id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.kits.remove(id);
  }
}
