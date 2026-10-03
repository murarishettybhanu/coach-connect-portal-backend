import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TribeMembersService } from './tribe-members.service';
import { TribeMembersController } from './tribe-members.controller';
import {
  TribeMember,
  TribeMemberSchema,
} from '../../schemas/tribe-member.schema';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';

// OrdersModule imports this one to keep members in sync; never the reverse
// (the Order model comes straight from Mongoose, not from OrdersModule).
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TribeMember.name, schema: TribeMemberSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Tribe.name, schema: TribeSchema },
    ]),
  ],
  providers: [TribeMembersService],
  controllers: [TribeMembersController],
  exports: [TribeMembersService],
})
export class TribeMembersModule {}
