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
} from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly tribesService: TribesService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  async findMyCampaigns(@Request() req) {
    const userId = req.user.userId || req.user.sub || req.user._id;
    const coach = await this.tribesService.findByUserId(userId);
    return this.campaignsService.findByCoach(coach._id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE, UserRole.ADMIN)
  create(@Body() campaignData: any) {
    return this.campaignsService.create(campaignData);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.campaignsService.findAll();
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.campaignsService.findBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.campaignsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE, UserRole.ADMIN)
  async update(@Param('id') id: string, @Body() campaignData: any, @Request() req) {
    if (req.user.role !== UserRole.ADMIN) {
      // A tribe may only edit its OWN campaigns and cannot reassign ownership.
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      const campaign: any = await this.campaignsService.findOne(id);
      const owner = String(campaign.coachId?._id || campaign.coachId);
      if (owner !== String(coach._id)) {
        throw new ForbiddenException('Not authorized to update this campaign');
      }
      delete campaignData.coachId;
      delete campaignData.claims;
    }
    return this.campaignsService.update(id, campaignData);
  }
}
