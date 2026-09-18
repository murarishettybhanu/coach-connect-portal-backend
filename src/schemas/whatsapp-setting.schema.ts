import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Singleton settings document — one row, looked up by this key, so the admin
// screen can change messaging behaviour without a redeploy.
export const WHATSAPP_SETTINGS_KEY = 'default';

export const DEFAULT_ACKNOWLEDGEMENT =
  "Thanks for messaging Tribe Merchandise — we'll reply shortly.";

export const DEFAULT_AFTER_HOURS =
  "Thanks for messaging Tribe Merchandise — we're away right now and will reply when we're back.";

@Schema({ timestamps: true })
export class WhatsappSetting extends Document {
  @Prop({ required: true, unique: true, default: WHATSAPP_SETTINGS_KEY })
  key: string;

  // Master switch for the automatic acknowledgement.
  @Prop({ default: true })
  autoReplyEnabled: boolean;

  @Prop({ default: DEFAULT_ACKNOWLEDGEMENT })
  acknowledgementText: string;

  // When on, messages arriving outside the hours below get `afterHoursText`
  // instead — same once-per-24h guard either way.
  @Prop({ default: false })
  businessHoursEnabled: boolean;

  @Prop({ default: DEFAULT_AFTER_HOURS })
  afterHoursText: string;

  // Local time, "HH:mm", interpreted in `timezone`.
  @Prop({ default: '09:00' })
  openTime: string;

  @Prop({ default: '18:00' })
  closeTime: string;

  // Days the business is open: 0 = Sunday … 6 = Saturday.
  @Prop({ type: [Number], default: [1, 2, 3, 4, 5, 6] })
  openDays: number[];

  // IANA zone — the audience is India-first, so that's the default.
  @Prop({ default: 'Asia/Kolkata' })
  timezone: string;
}

export const WhatsappSettingSchema =
  SchemaFactory.createForClass(WhatsappSetting);
