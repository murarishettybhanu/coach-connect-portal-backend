import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * One row per customer we've exchanged WhatsApp messages with — the inbox list.
 *
 * Also holds the auto-acknowledgement guard (`ackSentAt`) and the data needed to
 * know whether WhatsApp's 24-hour customer service window is still open, which
 * decides whether a free-form reply is allowed at all.
 */
@Schema({ timestamps: true })
export class WhatsappConversation extends Document {
  // Customer's wa_id — E.164 digits without '+', e.g. "919876543210".
  @Prop({ required: true, unique: true, index: true })
  contact: string;

  @Prop()
  profileName?: string;

  @Prop({ index: true })
  lastInboundAt?: Date;

  @Prop()
  lastOutboundAt?: Date;

  // Preview line for the inbox list.
  @Prop()
  lastMessagePreview?: string;

  @Prop()
  lastMessageDirection?: string;

  // Inbound messages not yet opened in the admin inbox. Local bookkeeping —
  // unrelated to WhatsApp's own read receipts.
  @Prop({ default: 0 })
  unreadCount: number;

  // When the one-time acknowledgement was last sent. Set atomically before the
  // send so concurrent webhook deliveries can't both claim it; cleared again if
  // the send fails, so the next message retries.
  @Prop()
  ackSentAt?: Date;
}

export const WhatsappConversationSchema =
  SchemaFactory.createForClass(WhatsappConversation);
