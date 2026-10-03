import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

/** One distinct delivery address a member has used. */
export interface MemberAddress {
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  sectorVillage?: string;
  city: string;
  district?: string;
  state: string;
  pincode: string;
  lastUsedAt: Date;
}

/**
 * A customer of one tribe, derived from that tribe's orders. Identity is
 * (coachId, phone) with the phone reduced to its last 10 digits, so the same
 * person ordering from two tribes is two members. Everything but the identity
 * is recomputed from the orders linked to it (`Order.memberId`) — see
 * TribeMembersService.recordOrder — so it is never edited by hand.
 */
@Schema({ timestamps: true })
export class TribeMember extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  // Last 10 digits of the order phone.
  @Prop({ required: true })
  phone: string;

  // Latest non-empty fullName across the member's orders.
  @Prop({ default: '' })
  name: string;

  @Prop()
  email?: string;

  @Prop()
  alternatePhone?: string;

  // Distinct addresses, newest lastUsedAt first. Address-pending orders add none.
  @Prop({
    type: [
      {
        _id: false,
        addressLine1: { type: String, required: true },
        addressLine2: { type: String },
        landmark: { type: String },
        sectorVillage: { type: String },
        city: { type: String },
        district: { type: String },
        state: { type: String },
        pincode: { type: String },
        lastUsedAt: { type: Date, required: true },
      },
    ],
    default: [],
  })
  addresses: MemberAddress[];

  // Linked orders that are not soft-deleted (rejected ones still count).
  @Prop({ default: 0 })
  orderCount: number;

  @Prop()
  firstOrderAt?: Date;

  @Prop()
  lastOrderAt?: Date;

  // When the member joined: their earliest linked order (deleted ones included).
  @Prop()
  joinedAt?: Date;
}

export const TribeMemberSchema = SchemaFactory.createForClass(TribeMember);

// The identity — and what makes the upsert in recordOrder race-safe.
TribeMemberSchema.index({ coachId: 1, phone: 1 }, { unique: true });
// Admin list: newest members first, optionally within some tribes.
TribeMemberSchema.index({ joinedAt: -1 });
TribeMemberSchema.index({ coachId: 1, joinedAt: -1 });
