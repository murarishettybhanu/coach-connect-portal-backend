import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Product, ProductSchema } from '../../schemas/product.schema';
import { TribeKitsService } from './tribe-kits.service';
import { TribeKitsController } from './tribe-kits.controller';
import { TribesModule } from '../tribes/tribes.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TribeKit.name, schema: TribeKitSchema },
      // Linked campaigns are synced to their kit and block its removal.
      { name: Campaign.name, schema: CampaignSchema },
      // Read-only: kit products' ownership, prices and production cost.
      { name: Product.name, schema: ProductSchema },
    ]),
    TribesModule,
  ],
  providers: [TribeKitsService],
  controllers: [TribeKitsController],
})
export class TribeKitsModule {}
