import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// A predefined bundle of catalog products, curated by admin and shown in the
// store / estimation flows so users can pick a ready-made package.
@Schema({ timestamps: true })
export class Kit extends Document {
  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  imageUrl?: string;

  @Prop({
    type: [
      {
        productId: {
          type: MongooseSchema.Types.ObjectId,
          ref: 'CatalogProduct',
        },
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

export const KitSchema = SchemaFactory.createForClass(Kit);
