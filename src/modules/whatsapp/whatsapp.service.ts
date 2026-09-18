import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  WhatsappMessage,
  WhatsappDirection,
} from '../../schemas/whatsapp-message.schema';

// Shape of the pieces of Meta's webhook payload we read. Everything is
// optional because Meta adds fields (and whole `field` types) over time and a
// webhook must never 500 on a shape it hasn't seen.
export interface WhatsappWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: WhatsappChangeValue;
    }>;
  }>;
}

interface WhatsappChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WhatsappInboundMessage[];
  statuses?: Array<{
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string }>;
  }>;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface WhatsappInboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  context?: { id?: string };
  text?: { body?: string };
  image?: WhatsappMedia;
  video?: WhatsappMedia;
  audio?: WhatsappMedia;
  document?: WhatsappMedia & { filename?: string };
  sticker?: WhatsappMedia;
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { emoji?: string; message_id?: string };
  [key: string]: unknown;
}

interface WhatsappMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  sha256?: string;
}

/**
 * WhatsApp Cloud API (Meta) inbound webhook.
 *
 * Two jobs, both driven by Meta:
 *  1. **Subscription handshake** — when the callback URL is saved in the Meta
 *     app dashboard, Meta GETs it with `hub.verify_token` and expects the
 *     `hub.challenge` echoed back as plain text.
 *  2. **Event delivery** — Meta POSTs batches signed with the app secret in
 *     `X-Hub-Signature-256`. Delivery is at-least-once: any non-2xx (or a
 *     timeout) is retried with backoff, and sustained failures get the webhook
 *     disabled. So we verify, persist idempotently, and always ack fast —
 *     per-message failures are logged, never bubbled into the response.
 *
 * Config (`.env`):
 *  - `WHATSAPP_VERIFY_TOKEN` — any random string; must match what's entered in
 *    the Meta dashboard. Required for the handshake.
 *  - `WHATSAPP_APP_SECRET` — Meta app secret, used for the payload signature.
 *    Required in production; absent in dev, signature checks are skipped.
 *  - `WHATSAPP_PHONE_NUMBER_ID` — optional; when set, events for any other
 *    business number are ignored.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly isProd = process.env.NODE_ENV === 'production';

  constructor(
    @InjectModel(WhatsappMessage.name)
    private readonly messageModel: Model<WhatsappMessage>,
  ) {}

  /**
   * Meta's subscription handshake. Returns the challenge to echo verbatim;
   * anything unexpected is a 403 so a wrong token never verifies.
   */
  verifySubscription(query: Record<string, string>): string {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!expected) {
      this.logger.error(
        'WHATSAPP_VERIFY_TOKEN is not set — cannot complete the webhook handshake',
      );
      throw new ServiceUnavailableException('WhatsApp webhook not configured');
    }
    if (mode !== 'subscribe' || !this.safeEqual(token ?? '', expected)) {
      this.logger.warn(
        `Rejected webhook verification (mode=${mode ?? 'none'}, token mismatch)`,
      );
      throw new ForbiddenException('Verification failed');
    }

    this.logger.log('WhatsApp webhook verified by Meta');
    return challenge ?? '';
  }

  /**
   * Validates `X-Hub-Signature-256` over the *raw* request body — the HMAC is
   * of the exact bytes Meta sent, so re-serializing the parsed JSON would not
   * reproduce it (key order, spacing, unicode escapes all differ).
   */
  assertValidSignature(rawBody: Buffer | undefined, signature?: string): void {
    const secret = process.env.WHATSAPP_APP_SECRET;

    if (!secret) {
      if (this.isProd) {
        // Fail closed: an unsigned public endpoint would let anyone inject messages.
        this.logger.error(
          'WHATSAPP_APP_SECRET is not set — refusing unverified webhook delivery',
        );
        throw new ServiceUnavailableException(
          'WhatsApp webhook not configured',
        );
      }
      this.logger.warn(
        'WHATSAPP_APP_SECRET is not set — skipping signature check (dev only)',
      );
      return;
    }

    if (!rawBody) {
      // Means `rawBody: true` was dropped from the Nest bootstrap.
      this.logger.error(
        'Raw request body unavailable — cannot verify signature',
      );
      throw new ForbiddenException('Invalid signature');
    }
    if (!signature?.startsWith('sha256=')) {
      throw new ForbiddenException('Invalid signature');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!this.safeEqual(signature.slice('sha256='.length), expected)) {
      this.logger.warn('Rejected webhook delivery with a bad signature');
      throw new ForbiddenException('Invalid signature');
    }
  }

  /**
   * Walks the payload and persists inbound messages. Never throws: Meta must
   * get its 200 even if one message is malformed, otherwise the whole batch is
   * redelivered indefinitely.
   */
  async handleEvent(payload: WhatsappWebhookPayload): Promise<void> {
    if (payload?.object !== 'whatsapp_business_account') {
      this.logger.warn(`Ignoring webhook for object "${payload?.object}"`);
      return;
    }

    const onlyNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (onlyNumberId && phoneNumberId && phoneNumberId !== onlyNumberId) {
          this.logger.debug(
            `Skipping event for another business number (${phoneNumberId})`,
          );
          continue;
        }

        // Delivery receipts for messages *we* sent (sent/delivered/read/failed).
        // Logged only — nothing outbound is tracked yet.
        for (const status of value.statuses ?? []) {
          if (status.errors?.length) {
            this.logger.warn(
              `WhatsApp status ${status.status} for ${status.id}: ` +
                status.errors.map((e) => `${e.code} ${e.title}`).join(', '),
            );
          } else {
            this.logger.debug(
              `WhatsApp status ${status.status} for ${status.id}`,
            );
          }
        }

        for (const error of value.errors ?? []) {
          this.logger.error(
            `WhatsApp webhook error ${error.code}: ${error.title ?? ''} ${error.message ?? ''}`,
          );
        }

        for (const message of value.messages ?? []) {
          try {
            await this.storeMessage(message, value);
          } catch (err) {
            this.logger.error(
              `Failed to store WhatsApp message ${message.id}: ${(err as Error).message}`,
              (err as Error).stack,
            );
          }
        }
      }
    }
  }

  /** Most recent inbound messages, newest first; optionally for one sender. */
  async list(from?: string, limit = 50): Promise<WhatsappMessage[]> {
    const filter = from ? { from } : {};
    return this.messageModel
      .find(filter)
      .sort({ sentAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 200))
      .exec();
  }

  /**
   * Idempotent insert keyed on the WhatsApp message id, so a redelivered batch
   * is a no-op rather than a duplicate row.
   */
  private async storeMessage(
    message: WhatsappInboundMessage,
    value: WhatsappChangeValue,
  ): Promise<void> {
    if (!message.id || !message.from) {
      this.logger.warn('Ignoring inbound message without an id or sender');
      return;
    }

    const contact = (value.contacts ?? []).find(
      (c) => c.wa_id === message.from,
    );
    const media = this.extractMedia(message);

    const doc = {
      waMessageId: message.id,
      direction: WhatsappDirection.INBOUND,
      from: message.from,
      profileName: contact?.profile?.name,
      phoneNumberId: value.metadata?.phone_number_id,
      displayPhoneNumber: value.metadata?.display_phone_number,
      type: message.type ?? 'unknown',
      text: this.extractText(message),
      mediaId: media?.id,
      mimeType: media?.mime_type,
      contextMessageId: message.context?.id,
      sentAt: message.timestamp
        ? new Date(Number(message.timestamp) * 1000)
        : new Date(),
      raw: message as unknown as Record<string, unknown>,
      handled: false,
    };

    const result = await this.messageModel.updateOne(
      { waMessageId: message.id },
      { $setOnInsert: doc },
      { upsert: true },
    );

    if (result.upsertedCount) {
      this.logger.log(
        `Inbound WhatsApp ${doc.type} from ${doc.from}` +
          (doc.text ? `: ${doc.text.slice(0, 120)}` : ''),
      );
      // Hook replies / lead creation in here — keep it non-blocking so the
      // webhook still acks within Meta's timeout.
    } else {
      this.logger.debug(`Duplicate delivery for ${message.id} ignored`);
    }
  }

  /** Best-effort readable body across the message types we care about. */
  private extractText(message: WhatsappInboundMessage): string | undefined {
    switch (message.type) {
      case 'text':
        return message.text?.body;
      case 'image':
      case 'video':
      case 'audio':
      case 'sticker':
        return this.extractMedia(message)?.caption;
      case 'document':
        return message.document?.caption ?? message.document?.filename;
      case 'button':
        return message.button?.text;
      case 'interactive':
        return (
          message.interactive?.button_reply?.title ??
          message.interactive?.list_reply?.title
        );
      case 'reaction':
        return message.reaction?.emoji;
      case 'location': {
        const { latitude, longitude, name } = message.location ?? {};
        return (
          name ?? (latitude != null ? `${latitude},${longitude}` : undefined)
        );
      }
      default:
        return undefined;
    }
  }

  private extractMedia(
    message: WhatsappInboundMessage,
  ): WhatsappMedia | undefined {
    return (
      message.image ??
      message.video ??
      message.audio ??
      message.document ??
      message.sticker
    );
  }

  /** Length-safe constant-time compare (timingSafeEqual throws on length mismatch). */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
