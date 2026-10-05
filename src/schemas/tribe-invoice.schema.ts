import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// An invoice the admin uploaded to a tribe. The PDF lives in the private part
// of the S3 bucket (`fileKey`, never returned by the API — it is
// `select: false`, and responses go through `toInvoiceResponse`). See the
// invoices module and CLAUDE.md "Invoices".
@Schema({ timestamps: true, collection: 'tribeinvoices' })
export class TribeInvoice extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tribe', required: true })
  coachId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true, trim: true })
  invoiceNumber: string;

  @Prop({ required: true })
  invoiceDate: Date;

  @Prop({ trim: true })
  reference?: string;

  // INR, ≥ 0, at most 2 decimals (validated by the DTOs).
  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ trim: true })
  note?: string;

  // S3 key `invoices/<coachId>/<32 hex>.pdf`. Internal only.
  @Prop({ required: true, select: false })
  fileKey: string;

  // The uploader's original file name, for the admin's display only.
  @Prop({ required: true })
  fileName: string;

  @Prop({ required: true })
  fileSize: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  uploadedBy?: MongooseSchema.Types.ObjectId;

  // First time the tribe opened or downloaded it ("New" until then). Reset
  // when the admin replaces the PDF.
  @Prop()
  viewedAt?: Date;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const TribeInvoiceSchema = SchemaFactory.createForClass(TribeInvoice);

// One live invoice per number per tribe; a soft-deleted one frees its number.
TribeInvoiceSchema.index(
  { coachId: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
// A tribe's invoices, newest invoice date first.
TribeInvoiceSchema.index({ coachId: 1, invoiceDate: -1 });
