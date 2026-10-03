import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { IndiaPostApiService } from './india-post-api.service';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';

@Module({
  imports: [
    // Read-only here: a tribe may only track its own orders' numbers.
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Tribe.name, schema: TribeSchema },
    ]),
  ],
  controllers: [TrackingController],
  providers: [TrackingService, IndiaPostApiService],
  exports: [TrackingService, IndiaPostApiService],
})
export class TrackingModule {}
