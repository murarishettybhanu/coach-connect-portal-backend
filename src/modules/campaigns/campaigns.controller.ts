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
import { CampaignsService } from './campaigns.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { CampaignStatus } from '../../schemas/campaign.schema';
import { CreateCampaignDto, UpdateCampaignDto } from './dto/campaign.dto';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { assertOwnedBy, refIdOf } from '../../common/utils/ownership';

// Shown when an admin has switched off campaign editing for the tribe.
const CAMPAIGNS_OFF =
  'Creating and editing campaigns is not enabled for your tribe. Contact the Tribe Merchandise team.';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly tribesService: TribesService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  async findMyCampaigns(@CurrentUserId() userId: string) {
    const tribeId = await this.tribesService.findIdByUserId(userId);
    return this.campaignsService.findByCoach(tribeId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE, UserRole.ADMIN)
  async create(
    @Body() dto: CreateCampaignDto,
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    // A tribe always creates under its own tribe, whatever coachId it sent.
    let coachId = dto.coachId;
    if (req.user.role !== UserRole.ADMIN) {
      coachId = await this.tribesService.findIdByUserId(userId);
      await this.tribesService.assertPermission(coachId, 'campaigns', CAMPAIGNS_OFF);
    }
    if (!coachId) throw new BadRequestException('coachId is required');
    return this.campaignsService.create(dto, coachId);
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
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    const campaign: any = await this.campaignsService.findOne(id);
    const owner = refIdOf(campaign.coachId);
    let coachId = owner;
    if (req.user.role !== UserRole.ADMIN) {
      // A tribe may only edit its OWN campaigns and cannot reassign ownership.
      const tribeId = await this.tribesService.findIdByUserId(userId);
      assertOwnedBy(owner, tribeId, 'Not authorized to update this campaign');
      await this.tribesService.assertPermission(tribeId, 'campaigns', CAMPAIGNS_OFF);
      // Stopping is final for a tribe; only an admin can reactivate a stopped campaign.
      if (
        campaign.status === CampaignStatus.STOPPED &&
        dto.status &&
        dto.status !== CampaignStatus.STOPPED
      ) {
        throw new ForbiddenException(
          'Only an admin can reactivate a stopped campaign',
        );
      }
    } else if (dto.coachId) {
      coachId = dto.coachId;
    }
    return this.campaignsService.update(id, dto, coachId);
  }
}
