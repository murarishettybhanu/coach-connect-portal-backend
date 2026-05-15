import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum CampaignType {
  WELCOME_KIT = 'WELCOME_KIT',
  STORE_SALE = 'STORE_SALE',
}

@Schema({ timestamps: true })
export class Campaign extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coach', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: CampaignType })
  type: CampaignType;

  @Prop({ type: [{ 
    productId: { type: MongooseSchema.Types.ObjectId, ref: 'Product' },
    retailPrice: Number,
  }] })
  products: {
    productId: MongooseSchema.Types.ObjectId;
    retailPrice?: number; // Only for STORE_SALE
  }[];

  @Prop({ required: true, unique: true })
  slug: string; // Used for campaign URL

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  description?: string;

  @Prop({ default: 0 })
  claims: number;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
