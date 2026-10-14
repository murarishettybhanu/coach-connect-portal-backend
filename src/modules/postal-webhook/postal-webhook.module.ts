import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../../schemas/order.schema';
import {
  PostalWebhookLog,
  PostalWebhookLogSchema,
} from '../../schemas/postal-webhook-log.schema';
import {
  PostalEvent,
  PostalEventSchema,
} from '../../schemas/postal-event.schema';
import { OrdersModule } from '../orders/orders.module';
import {
  PostalSyncController,
  PostalWebhookController,
} from './postal-webhook.controller';
import { PostalSyncService } from './postal-sync.service';
import { TrackingModule } from '../tracking/tracking.module';
import { PostalWebhookService } from './postal-webhook.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PostalEvent.name, schema: PostalEventSchema },
      { name: Order.name, schema: OrderSchema },
      { name: PostalWebhookLog.name, schema: PostalWebhookLogSchema },
    ]),
    OrdersModule,
    TrackingModule,
  ],
  controllers: [PostalWebhookController, PostalSyncController],
  providers: [PostalWebhookService, PostalSyncService],
  exports: [PostalWebhookService],
})
export class PostalWebhookModule {}
