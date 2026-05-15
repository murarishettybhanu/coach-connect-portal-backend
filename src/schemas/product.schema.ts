import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class Product extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coach', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ required: true, min: 0 })
  baseProductionCost: number;

  @Prop({ default: 0 })
  retailPrice: number;

  @Prop({ required: true, unique: true })
  sku: string;

  @Prop({ default: 0 })
  stockLevel: number;

  @Prop()
  imageUrl?: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
