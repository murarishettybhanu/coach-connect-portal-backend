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

  // When codes went out over the last day, newest last — drives the rolling
  // hourly/daily caps. Pruned on every send, so it never grows past the cap.
  @Prop({ type: [Date], default: [] })
  sendLog: Date[];

  // Set when the code was entered correctly; how long that stays good is
  // decided by the order flow, not here.
  @Prop()
  verifiedAt?: Date;
}

export const WhatsappOtpSchema = SchemaFactory.createForClass(WhatsappOtp);
