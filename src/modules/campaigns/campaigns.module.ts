import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { TribesModule } from '../tribes/tribes.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Campaign.name, schema: CampaignSchema }]),
    TribesModule,
  ],
  providers: [CampaignsService],
  controllers: [CampaignsController],
  exports: [CampaignsService],
})
export class CampaignsModule {}
