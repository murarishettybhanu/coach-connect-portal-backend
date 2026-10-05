import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Product, ProductSchema } from '../../schemas/product.schema';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

// Models come straight from Mongoose (not OrdersModule / RestockModule /
// TribeKitsModule), so this module depends on no other feature module and
// can't form a DI cycle. Stock levels reuse the pure restock maths, the
// restock dispatch-count helpers and `buildableKits` from tribe-kits.
@Module({
  imports: [
    MongooseModule.forFeature([
      // All read-only.
      { name: Order.name, schema: OrderSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Product.name, schema: ProductSchema },
      { name: TribeKit.name, schema: TribeKitSchema },
      { name: Tribe.name, schema: TribeSchema },
    ]),
  ],
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
