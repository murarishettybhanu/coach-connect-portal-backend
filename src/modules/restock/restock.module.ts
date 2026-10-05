import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RestockRequest,
  RestockRequestSchema,
} from '../../schemas/restock-request.schema';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Product, ProductSchema } from '../../schemas/product.schema';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { RestockService } from './restock.service';
import {
  AdminRestockController,
  RestockController,
} from './restock.controller';

// Models come straight from Mongoose (not OrdersModule / TribeKitsModule), so
// this module depends on no other feature module and can't form a DI cycle.
// Kit stock reuses the pure `buildableKits` from tribe-kits.service.ts.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RestockRequest.name, schema: RestockRequestSchema },
      // Read-only: stock, dispatches and ownership.
      { name: Order.name, schema: OrderSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Product.name, schema: ProductSchema },
      { name: TribeKit.name, schema: TribeKitSchema },
      { name: Tribe.name, schema: TribeSchema },
    ]),
  ],
  providers: [RestockService],
  controllers: [RestockController, AdminRestockController],
})
export class RestockModule {}
