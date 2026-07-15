import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// Audit trail for manual stock movements on a product. One document per
// add/remove action so admins can see the full history with date & time.
@Schema({ timestamps: true })
export class InventoryLog extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId: MongooseSchema.Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe' })
  coachId?: MongooseSchema.Types.ObjectId;

  @Prop({ enum: ['ADD', 'REMOVE'], required: true })
  type: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  // Free-text reason. Required by the API on REMOVE, optional on ADD.
  @Prop()
  reason?: string;

  // Stock level immediately after this movement was applied.
  @Prop({ required: true })
  resultingStock: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  performedBy?: MongooseSchema.Types.ObjectId;
}

export const InventoryLogSchema = SchemaFactory.createForClass(InventoryLog);
