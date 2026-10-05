import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum RestockStatus {
  NEW = 'NEW',
  CONFIRMED = 'CONFIRMED',
  IN_PRODUCTION = 'IN_PRODUCTION',
  RECEIVED = 'RECEIVED',
  DECLINED = 'DECLINED',
}

export enum RestockItemKind {
  KIT = 'KIT',
  PRODUCT = 'PRODUCT',
}

/** Statuses that still count as "a restock is on its way" for the tribe. */
export const OPEN_RESTOCK_STATUSES = [
  RestockStatus.NEW,
  RestockStatus.CONFIRMED,
  RestockStatus.IN_PRODUCTION,
];

export interface RestockRequestItem {
  kind: RestockItemKind;
  // The Product or TribeKit id (which one depends on `kind`).
  refId: MongooseSchema.Types.ObjectId;
  // Snapshots taken when the request was made — the product/kit may be
  // renamed, restocked or deleted afterwards.
  name: string;
  quantity: number;
  stockAtRequest: number;
}

// A tribe asking the admin to restock some of its products/kits. See the
// restock module (src/modules/restock) and CLAUDE.md "Restock reminders".
@Schema({ timestamps: true })
export class RestockRequest extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({
    type: [
      {
        _id: false,
        kind: { type: String, enum: RestockItemKind, required: true },
        refId: { type: MongooseSchema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        stockAtRequest: { type: Number, required: true },
      },
    ],
    default: [],
  })
  items: RestockRequestItem[];

  @Prop()
  note?: string;

  @Prop()
  neededBy?: Date;

  @Prop({ enum: RestockStatus, default: RestockStatus.NEW })
  status: RestockStatus;

  @Prop()
  adminNote?: string;

  // When an admin first opened it. Unread (badge + pop-ups) = NEW and never
  // opened — same pattern as website enquiries.
  @Prop()
  seenAt?: Date;
}

export const RestockRequestSchema =
  SchemaFactory.createForClass(RestockRequest);

// The unread count the admin portal polls.
RestockRequestSchema.index({ status: 1, seenAt: 1, createdAt: -1 });
// A tribe's own requests (overview's pending request, "my requests").
RestockRequestSchema.index({ coachId: 1, createdAt: -1 });
