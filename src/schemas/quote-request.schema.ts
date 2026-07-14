import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum RequestSource {
  GUEST = 'GUEST', // "Get Estimation" — logged-out visitor (name + mobile)
  COACH = 'COACH', // Quote request raised by a logged-in coach
}

export enum RequestStatus {
  NEW = 'NEW',
  REVIEWED = 'REVIEWED',
  QUOTED = 'QUOTED',
  CLOSED = 'CLOSED',
}

// A pricing estimation (guest) or quote request (coach). Line items and the
// total are snapshotted at submit time so later catalog price changes don't
// rewrite historical requests.
@Schema({ timestamps: true })
export class QuoteRequest extends Document {
  @Prop({ required: true, enum: RequestSource })
  source: RequestSource;

  // Guest contact (source = GUEST)
  @Prop()
  name?: string;

  @Prop()
  mobile?: string;

  // Coach reference (source = COACH)
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coach' })
  coachId?: MongooseSchema.Types.ObjectId;

  @Prop()
  coachName?: string;

  // Optional origin kit (if the user started from a predefined kit).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Kit' })
  kitId?: MongooseSchema.Types.ObjectId;

  @Prop()
  kitName?: string;

  @Prop({
    type: [
      {
        productId: {
          type: MongooseSchema.Types.ObjectId,
          ref: 'CatalogProduct',
        },
        name: String,
        quantity: Number,
        price: Number, // per-unit price snapshot
      },
    ],
    default: [],
  })
  items: {
    productId: MongooseSchema.Types.ObjectId;
    name: string;
    quantity: number;
    price: number;
  }[];

  @Prop({ default: 0 })
  estimatedTotal: number;

  @Prop({ enum: RequestStatus, default: RequestStatus.NEW })
  status: RequestStatus;

  @Prop()
  note?: string;
}

export const QuoteRequestSchema = SchemaFactory.createForClass(QuoteRequest);
