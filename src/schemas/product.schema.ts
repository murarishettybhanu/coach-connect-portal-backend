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

  // Total stock. May go below zero — orders never block on stock (see sizeStock).
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

  // Sizes taken off sale. Hidden from the claim and checkout forms but kept, with
  // whatever stock they hold, so they can be re-enabled to sell the rest off.
  @Prop({ type: [String], default: undefined })
  disabledSizes?: string[];

  // Stock held per size, for SIZE products. `stockLevel` stays the product total;
  // whatever it holds beyond the sum of these is "Unassigned" — not yet counted
  // into a size (all of it, until the admin splits it). An array rather than a
  // map because Mongo keys can't contain dots ("32.5"), and because it lets one
  // positional $inc move a size and the total together.
  // Quantities may go below zero: orders never block on stock, and a negative
  // number is the shortfall the admin has to restock.
  @Prop({
    type: [
      {
        _id: false,
        size: { type: String, required: true },
        qty: { type: Number, default: 0 },
      },
    ],
    default: undefined,
  })
  sizeStock?: { size: string; qty: number }[];

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
