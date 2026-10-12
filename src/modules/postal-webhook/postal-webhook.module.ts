import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../../schemas/order.schema';
import {
  PostalEvent,
  PostalEventSchema,
} from '../../schemas/postal-event.schema';
import { OrdersModule } from '../orders/orders.module';
import { PostalWebhookController } from './postal-webhook.controller';
import { PostalWebhookService } from './postal-webhook.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PostalEvent.name, schema: PostalEventSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    OrdersModule,
  ],
  controllers: [PostalWebhookController],
  providers: [PostalWebhookService],
  exports: [PostalWebhookService],
})
export class PostalWebhookModule {}
