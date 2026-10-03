import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum EnquiryStatus {
  NEW = 'NEW',
  // Someone has reached out to the lead (call / email / WhatsApp).
  CONTACTED = 'CONTACTED',
  REVIEWED = 'REVIEWED',
  QUOTED = 'QUOTED',
  CLOSED = 'CLOSED',
}

// A website "Request a Quote" enquiry submitted from the public marketing site.
@Schema({ timestamps: true })
export class Enquiry extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  email: string;

  @Prop()
  company?: string;

  @Prop()
  phone?: string;

  // What they need (product/service interest) and desired timeline.
  @Prop()
  interest?: string;

  @Prop()
  timeline?: string;

  @Prop()
  message?: string;

  @Prop({ enum: EnquiryStatus, default: EnquiryStatus.NEW })
  status: EnquiryStatus;

  // When an admin first opened it. An enquiry is unread — counted on the
  // portal's badge and announced as new — while it's NEW and never opened.
  @Prop()
  seenAt?: Date;
}

export const EnquirySchema = SchemaFactory.createForClass(Enquiry);

// The unread count the admin portal polls.
EnquirySchema.index({ status: 1, seenAt: 1, createdAt: -1 });
