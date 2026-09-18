import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * One pending verification per number. The code itself is never stored — only
 * a bcrypt hash — so a leaked database dump can't be replayed against the
 * campaign forms.
 */
@Schema({ timestamps: true })
export class WhatsappOtp extends Document {
  // wa_id (digits, country code included).
  @Prop({ required: true, unique: true, index: true })
  contact: string;

  @Prop({ required: true })
  codeHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  // Wrong guesses against the current code; capped to stop brute force.
  @Prop({ default: 0 })
  attempts: number;

  // Drives the resend cooldown.
  @Prop({ required: true })
  lastSentAt: Date;

  // Set when the code was entered correctly; how long that stays good is
  // decided by the order flow, not here.
  @Prop()
  verifiedAt?: Date;
}

export const WhatsappOtpSchema = SchemaFactory.createForClass(WhatsappOtp);
