import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

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
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coach', required: true })
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
    email?: string;
  };

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
