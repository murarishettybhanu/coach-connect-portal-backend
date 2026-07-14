import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// Master catalog product maintained by admin (distinct from the per-coach
// `Product`). Used to build kits and to estimate / quote package pricing.
@Schema({ timestamps: true })
export class CatalogProduct extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Category', required: true })
  categoryId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  imageUrl?: string;

  // Per-unit price used for estimation / quoting.
  @Prop({ required: true, min: 0, default: 0 })
  price: number;

  // Optional size options offered for this product.
  @Prop({ type: [String], default: [] })
  sizes: string[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const CatalogProductSchema =
  SchemaFactory.createForClass(CatalogProduct);
