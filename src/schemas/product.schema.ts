import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class Product extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
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

  // Optional per-order customization the customer must provide when claiming/
  // buying: 'TEXT' (custom text), 'PHOTO' (image URL), or 'SIZE' (size choice).
  @Prop({ enum: ['TEXT', 'PHOTO', 'SIZE'] })
  customizationType?: string;

  // The size choices offered to the customer when customizationType is 'SIZE'.
  // Empty falls back to the standard XS–XXL run, so existing products keep
  // behaving as they did; set it for anything sized differently (waist inches,
  // shoe sizes, "Free size").
  @Prop({ type: [String], default: undefined })
  sizeOptions?: string[];

  @Prop({ default: true })
  isActive: boolean;

  // Soft-delete flag. Deleted products stay in the DB so historical orders can
  // still resolve their name/sku/image via populate, but they are excluded from
  // all product listings and new campaign/storefront listings.
  @Prop({ default: false })
  isDeleted: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ coachId: 1, isDeleted: 1 });
