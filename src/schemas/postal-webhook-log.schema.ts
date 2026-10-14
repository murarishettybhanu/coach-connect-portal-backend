import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// One India Post webhook delivery, as received — kept 30 days (TTL) so the
// first real deliveries, and any format surprise later, can be inspected.
@Schema({
  timestamps: { createdAt: 'receivedAt', updatedAt: false },
  collection: 'postalwebhooklogs',
})
export class PostalWebhookLog extends Document {
  @Prop({ enum: ['BOOKING', 'OTHER'], required: true })
  channel: 'BOOKING' | 'OTHER';

  @Prop({ default: '' })
  contentType: string;

  @Prop({ default: 0 })
  bytes: number;

  // The body as text (first 20 000 characters).
  @Prop({ default: '' })
  raw: string;

  // Events read from it / newly stored.
  @Prop({ default: 0 })
  received: number;

  @Prop({ default: 0 })
  stored: number;

  @Prop()
  error?: string;

  receivedAt: Date;
}

export const PostalWebhookLogSchema =
  SchemaFactory.createForClass(PostalWebhookLog);
PostalWebhookLogSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);
