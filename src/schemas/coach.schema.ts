import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class Coach extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true, unique: true })
  username: string; // Used for storefront URL

  @Prop()
  name: string; // Display name

  @Prop()
  brand: string; // Brand name (e.g. FocusFwd)

  @Prop()
  bio?: string;

  @Prop()
  tagline?: string;

  @Prop({ type: Object, default: {} })
  socialLinks?: {
    instagram?: string;
    twitter?: string;
    youtube?: string;
    linkedin?: string;
  };

  @Prop()
  contactEmail?: string;

  @Prop()
  profileImage?: string;

  @Prop({ default: 0 })
  walletBalance: number;

  @Prop({ type: Object, default: {} })
  storefrontConfig: {
    bannerImage?: string;
    themeColor?: string;
    customDomain?: string;
  };

  @Prop({ type: Object, default: {} })
  bankingDetails: {
    accountHolderName?: string;
    accountNumber?: string;
    ifscCode?: string;
    bankName?: string;
  };

  @Prop({ default: true })
  isActive: boolean;
}

export const CoachSchema = SchemaFactory.createForClass(Coach);
