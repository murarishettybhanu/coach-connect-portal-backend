import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum BarcodeType {
  SPEED_POST = 'SPEED_POST',
  BUSINESS_PARCEL = 'BUSINESS_PARCEL',
}

// A postal tracking barcode uploaded by the admin. It is AVAILABLE while
// `assignedOrderId` is null, and USED once claimed by an order. A barcode is
// claimed atomically (findOneAndUpdate on the available pool), so it can never be
// assigned to two orders.
@Schema({ timestamps: true })
export class Barcode extends Document {
  @Prop({ required: true, unique: true, trim: true })
  code: string;

  @Prop({ required: true, enum: BarcodeType })
  type: BarcodeType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', default: null })
  assignedOrderId: MongooseSchema.Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  assignedAt: Date | null;
}

export const BarcodeSchema = SchemaFactory.createForClass(Barcode);

// Fast "next available barcode of type" claims and release-by-order lookups.
BarcodeSchema.index({ type: 1, assignedOrderId: 1, createdAt: 1 });
BarcodeSchema.index({ assignedOrderId: 1 });
// `code` is already uniquely indexed via @Prop({ unique: true }).
