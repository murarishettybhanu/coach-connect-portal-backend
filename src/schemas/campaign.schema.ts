import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { BarcodeType } from './barcode.schema';

export enum CampaignType {
  WELCOME_KIT = 'WELCOME_KIT',
  STORE_SALE = 'STORE_SALE',
}

export enum CampaignStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  STOPPED = 'STOPPED',
}

// How the public claim form collects the shipping address:
// - WITH_ADDRESS: one form collects details + address (default, all campaign types).
// - WITHOUT_ADDRESS: step 1 collects details only; address is attached later (via the
//   standalone address page or bulk upload). Only valid for WELCOME_KIT campaigns.
export enum CampaignFormType {
  WITH_ADDRESS = 'WITH_ADDRESS',
  WITHOUT_ADDRESS = 'WITHOUT_ADDRESS',
}

@Schema({ timestamps: true })
export class Campaign extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: CampaignType })
  type: CampaignType;

  @Prop({
    type: [{
      productId: { type: MongooseSchema.Types.ObjectId, ref: 'Product' },
      retailPrice: Number,
    }]
  })
  products: {
    productId: MongooseSchema.Types.ObjectId;
    retailPrice?: number; // Only for STORE_SALE
  }[];

  @Prop({ required: true, unique: true })
  slug: string; // Used for campaign URL

  @Prop({ type: String, enum: CampaignStatus, default: CampaignStatus.ACTIVE })
  status: CampaignStatus;

  @Prop({
    type: String,
    enum: CampaignFormType,
    default: CampaignFormType.WITH_ADDRESS,
  })
  formType: CampaignFormType;

  // Postal service used for this campaign's orders — determines which barcode pool
  // an order draws from when it's dispatched. Optional: when left unset the delivery
  // type is chosen (and confirmed) at dispatch time instead of defaulting silently.
  @Prop({
    type: String,
    enum: BarcodeType,
    default: null,
  })
  deliveryType: BarcodeType | null;

  @Prop()
  description?: string;

  // Optional shipping metadata for the kit/parcel (dimensions in cm, weight in grams).
  @Prop()
  length?: number;

  @Prop()
  breadth?: number;

  @Prop()
  height?: number;

  @Prop()
  packageWeight?: number;

  @Prop({ default: 0 })
  claims: number;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);

CampaignSchema.index({ coachId: 1 });
