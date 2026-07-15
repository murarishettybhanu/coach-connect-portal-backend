import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// A coach-scoped kit: a named bundle of the coach's own products (with per-item
// quantities). Buildable inventory is derived live from product stock, not
// stored. Distinct from the master-catalog `Kit` (which bundles CatalogProduct).
@Schema({ timestamps: true })
export class TribeKit extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  imageUrl?: string;

  @Prop({
    type: [
      {
        productId: { type: MongooseSchema.Types.ObjectId, ref: 'Product' },
        quantity: { type: Number, default: 1 },
      },
    ],
    default: [],
  })
  items: { productId: MongooseSchema.Types.ObjectId; quantity: number }[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const TribeKitSchema = SchemaFactory.createForClass(TribeKit);
