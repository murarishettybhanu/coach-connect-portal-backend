import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// One scan event India Post pushed to our webhook (Customer Integrations
// §13.8). Kept per article, not on the order: an article can carry dozens of
// scans and they arrive before we know (or even when we never learn) which
// order it belongs to. See the postal-webhook module and CLAUDE.md.
@Schema({
  timestamps: { createdAt: 'receivedAt', updatedAt: false },
  collection: 'postalevents',
})
export class PostalEvent extends Document {
  // Uppercased article (tracking) number, e.g. CA182468665IN.
  @Prop({ required: true, index: true })
  articleNumber: string;

  // The one non-deleted order carrying this tracking number, when there is one.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', index: true })
  orderId?: MongooseSchema.Types.ObjectId;

  // Which of our two webhook URLs it came to.
  @Prop({ enum: ['BOOKING', 'OTHER'], required: true })
  channel: 'BOOKING' | 'OTHER';

  @Prop({ default: '' })
  eventCode: string;

  @Prop({ default: '' })
  description: string;

  // event_date + event_time, read as IST.
  @Prop({ required: true })
  eventAt: Date;

  @Prop({ default: '' })
  office: string;

  @Prop({ default: '' })
  officeId: string;

  @Prop({ default: '' })
  nonDeliveryReason: string;

  // The payload as received, for anything we don't map yet.
  @Prop({ type: MongooseSchema.Types.Mixed })
  raw: Record<string, unknown>;

  receivedAt: Date;
}

export const PostalEventSchema = SchemaFactory.createForClass(PostalEvent);
// India Post may deliver an event more than once; the same scan is stored once.
PostalEventSchema.index(
  { articleNumber: 1, eventCode: 1, eventAt: 1, officeId: 1 },
  { unique: true },
);
