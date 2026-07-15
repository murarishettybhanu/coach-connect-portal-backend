import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum EnquiryStatus {
  NEW = 'NEW',
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
}

export const EnquirySchema = SchemaFactory.createForClass(Enquiry);
