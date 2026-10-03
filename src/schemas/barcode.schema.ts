import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum BarcodeType {
  SPEED_POST = 'SPEED_POST',
  BUSINESS_PARCEL = 'BUSINESS_PARCEL',
}

// A postal tracking barcode uploaded by the admin.
//
// It is AVAILABLE only while nothing holds it: no order has claimed it AND it
// has not been written off by hand. USED therefore means one of two things —
// claimed by an order (`assignedOrderId`), or written off by an admin
// (`manuallyUsedAt`) because the label was damaged or consumed outside the
// system. A barcode is claimed atomically (findOneAndUpdate on the available
// pool), so it can never be assigned to two orders.
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

  // Set when an admin marks a barcode used without an order — a damaged label,
  // or one consumed outside the system. Keeps it out of the available pool
  // without inventing a fake order to hold it.
  @Prop({ type: Date, default: null })
  manuallyUsedAt: Date | null;

  @Prop({ trim: true })
  manualUseNote?: string;

  // Who wrote it off, so the decision is attributable.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  manuallyUsedBy: MongooseSchema.Types.ObjectId | null;
}

export const BarcodeSchema = SchemaFactory.createForClass(Barcode);

// Fast "next available barcode of type" claims and release-by-order lookups.
// `manuallyUsedAt` is part of the claim filter, so it belongs in the index.
BarcodeSchema.index({
  type: 1,
  assignedOrderId: 1,
  manuallyUsedAt: 1,
  createdAt: 1,
});
// At most one barcode per order, enforced by the database rather than by a
// read-then-claim in the service (which two concurrent packs could both pass).
// Partial, so the many unassigned barcodes (null) don't collide. Named apart
// from the old non-unique `assignedOrderId_1`, which can be dropped once this
// one has built. Building it fails if any order already holds two barcodes —
// release the extras first.
BarcodeSchema.index(
  { assignedOrderId: 1 },
  {
    name: 'assignedOrderId_unique',
    unique: true,
    partialFilterExpression: { assignedOrderId: { $type: 'objectId' } },
  },
);
// `code` is already uniquely indexed via @Prop({ unique: true }).
