import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum TransactionType {
  COMMISSION = 'COMMISSION',
  PAYOUT = 'PAYOUT',
  DEBIT = 'DEBIT',
}

@Schema({ timestamps: true })
export class Transaction extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
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

// Also serves coachId-only lookups (balance, ledger) as its prefix.
TransactionSchema.index({ coachId: 1, createdAt: -1 });
TransactionSchema.index({ orderId: 1 });
// A bank transfer is recorded once: re-submitting the same UTR is refused.
// Partial rather than sparse so legacy blank/absent UTRs don't collide.
TransactionSchema.index(
  { utrReference: 1 },
  { unique: true, partialFilterExpression: { utrReference: { $gt: '' } } },
);
