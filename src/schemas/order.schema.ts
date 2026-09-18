import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { BarcodeType } from './barcode.schema';

export enum OrderStatus {
  NEW = 'NEW',
  PACKED = 'PACKED',
  DISPATCHED = 'DISPATCHED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum OrderType {
  WELCOME_KIT = 'WELCOME_KIT',
  STORE_SALE = 'STORE_SALE',
}

export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Schema({ timestamps: true })
export class Order extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Campaign' })
  campaignId?: MongooseSchema.Types.ObjectId;

  @Prop({ required: true, enum: OrderType })
  type: OrderType;

  @Prop({ required: true, enum: OrderStatus, default: OrderStatus.NEW })
  status: OrderStatus;

  @Prop({ type: String, enum: ApprovalStatus, default: null })
  approvalStatus: ApprovalStatus | null;

  @Prop()
  approvalNote?: string;

  @Prop()
  approvedBy?: string;

  @Prop()
  approvedAt?: Date;

  @Prop({ type: [{
    productId: { type: MongooseSchema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, required: true },
    baseCost: { type: Number, required: true },
    retailPrice: { type: Number },
    commission: { type: Number, default: 0 },
    selected: { type: Boolean, default: true }, // unchecked during approval = not fulfilled
    customizationType: { type: String }, // TEXT | PHOTO | SIZE (from the product)
    customizationValue: { type: String }, // the customer-provided value
  }] })
  items: {
    productId: MongooseSchema.Types.ObjectId;
    quantity: number;
    baseCost: number;
    retailPrice?: number;
    commission: number;
    selected: boolean;
    customizationType?: string;
    customizationValue?: string;
  }[];

  @Prop({ default: 0 })
  totalCommission: number;

  @Prop({ default: 0 })
  totalAmount: number;

  @Prop({ default: 0 })
  totalCost: number;

  @Prop({ required: true, type: Object })
  shippingAddress: {
    fullName: string;
    addressLine1: string;
    addressLine2?: string;
    landmark?: string;
    sectorVillage?: string;
    city: string;
    district?: string;
    state: string;
    pincode: string;
    phone: string;
    // Second number to call if the WhatsApp number doesn't take calls — the
    // courier uses this, so it prints on the label when present.
    alternatePhone?: string;
    email?: string;
  };

  // When the customer ticked the delivery-details agreement on the public form.
  // Kept as a timestamp, not a flag, so a dispute has a date attached.
  @Prop()
  termsAcceptedAt?: Date;

  // True for "without address" campaign claims where step 1 captured only contact
  // details; the delivery address is attached later (address page or bulk upload).
  @Prop({ default: false })
  addressPending: boolean;

  // Postal service for this order — inherited from the campaign when it sets one,
  // otherwise unset until chosen (and confirmed) at dispatch. Changeable while the
  // order is NEW. Determines which barcode pool is used when the order is dispatched.
  @Prop({ type: String, enum: BarcodeType, default: null })
  deliveryType: BarcodeType | null;

  // True when the order was packed but no barcode of its delivery type was
  // available — it needs a barcode assigned once more are uploaded.
  @Prop({ default: false })
  barcodePending: boolean;

  // Soft delete — hidden from all normal lists/pipeline; recoverable via restore.
  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  trackingNumber?: string;

  @Prop()
  courierName?: string;

  @Prop()
  paymentReference?: string;

  // Set when the order is marked DELIVERED — used to sort the paginated Delivered list.
  @Prop()
  deliveredAt?: Date;

  // Audit trail of every status transition, newest appended last.
  @Prop({
    type: [{
      status: { type: String, required: true },
      at: { type: Date, required: true },
      note: { type: String },
    }],
    default: [],
  })
  statusHistory: {
    status: string;
    at: Date;
    note?: string;
  }[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);

// Indexes for the hot query paths (fulfillment board, coach feeds, approvals).
OrderSchema.index({ coachId: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ approvalStatus: 1 });
OrderSchema.index({ campaignId: 1 });
// Fast lookup of address-pending claims per campaign (step-2 attach + bulk upload).
OrderSchema.index({ campaignId: 1, addressPending: 1 });
OrderSchema.index({ coachId: 1, isDeleted: 1 });
