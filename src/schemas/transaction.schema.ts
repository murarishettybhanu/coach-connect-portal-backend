import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum TransactionType {
  COMMISSION = 'COMMISSION',
  PAYOUT = 'PAYOUT',
  DEBIT = 'DEBIT',
}

@Schema({ timestamps: true })
export class Transaction extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coach', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true, enum: TransactionType })
  type: TransactionType;

  @Prop({ required: true })
  amount: number; // Positive for commission, negative for payout? Or just positive and use type.

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: MongooseSchema.Types.ObjectId;

  @Prop()
  utrReference?: string; // For payouts

  @Prop()
  description?: string;

  @Prop({ default: 'COMPLETED' })
  status: string;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
