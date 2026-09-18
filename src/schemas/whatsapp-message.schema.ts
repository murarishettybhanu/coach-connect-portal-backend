import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum WhatsappSendStatus {
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum WhatsappDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

// A message received from a customer on the WhatsApp Cloud API webhook.
@Schema({ timestamps: true })
export class WhatsappMessage extends Document {
  // WhatsApp's own id (`wamid.…`). Unique because Meta re-delivers an event
  // until it gets a 2xx, so retries must not create duplicate rows.
  @Prop({ required: true, unique: true, index: true })
  waMessageId: string;

  @Prop({ enum: WhatsappDirection, default: WhatsappDirection.INBOUND })
  direction: WhatsappDirection;

  // The customer's wa_id on both sides of the conversation — E.164 digits
  // without '+', e.g. "919876543210". This is what groups a thread, since
  // `from` flips to our own number on outbound messages.
  @Prop({ required: true, index: true })
  contact: string;

  // Sender: the customer's wa_id inbound, our business number outbound.
  @Prop({ required: true })
  from: string;

  // Recipient — set on outbound messages only.
  @Prop()
  to?: string;

  // WhatsApp profile name of the sender, when the contact block carries one.
  @Prop()
  profileName?: string;

  // Our business number that received it (Cloud API ids, for multi-number setups).
  @Prop({ index: true })
  phoneNumberId?: string;

  @Prop()
  displayPhoneNumber?: string;

  // WhatsApp message type: text, image, audio, video, document, sticker,
  // location, contacts, button, interactive, reaction, order, system, unknown.
  @Prop({ required: true })
  type: string;

  // Best-effort human-readable body: the text, the caption, the button/list
  // title the user tapped, or a short placeholder for media-only messages.
  @Prop()
  text?: string;

  // Media payloads carry an id that must be exchanged for a download URL via
  // the Graph API (URLs are short-lived, so we store the id, not a link).
  @Prop()
  mediaId?: string;

  @Prop()
  mimeType?: string;

  // Set when the customer replied to one of our messages (wamid of the quoted one).
  @Prop()
  contextMessageId?: string;

  // When WhatsApp says the customer sent it (not when we stored it).
  @Prop({ required: true })
  sentAt: Date;

  // Full original message object, kept so nothing is lost for message types we
  // don't parse yet and for debugging against Meta's logs.
  @Prop({ type: Object })
  raw?: Record<string, unknown>;

  // Outbound only: which approved template was used, when type is 'template'.
  @Prop()
  templateName?: string;

  // Outbound only: whether the Graph API accepted the send.
  @Prop({ enum: WhatsappSendStatus })
  sendStatus?: WhatsappSendStatus;

  // Outbound only: why a send failed, surfaced in the admin inbox.
  @Prop()
  errorMessage?: string;

  // True for messages the system sent on its own (the acknowledgement), as
  // opposed to a human reply typed in the admin inbox.
  @Prop({ default: false })
  automated: boolean;

  // Flipped once the message has been acted on (reply sent, lead created, …).
  @Prop({ default: false, index: true })
  handled: boolean;
}

export const WhatsappMessageSchema =
  SchemaFactory.createForClass(WhatsappMessage);
