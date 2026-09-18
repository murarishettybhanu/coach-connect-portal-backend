import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  WhatsappMessage,
  WhatsappDirection,
  WhatsappSendStatus,
} from '../../schemas/whatsapp-message.schema';
import { WhatsappConversation } from '../../schemas/whatsapp-conversation.schema';
import {
  WhatsappSetting,
  WHATSAPP_SETTINGS_KEY,
} from '../../schemas/whatsapp-setting.schema';
import {
  WhatsappApiService,
  type SendTemplateInput,
  type WhatsappTemplate,
} from './whatsapp-api.service';

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

// WhatsApp's customer service window: free-form messages are only allowed
// within 24 hours of the customer's last message. Outside it, Meta rejects
// anything but an approved template.
const WINDOW_MS = 24 * 60 * 60 * 1000;

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
    @InjectModel(WhatsappConversation.name)
    private readonly conversationModel: Model<WhatsappConversation>,
    @InjectModel(WhatsappSetting.name)
    private readonly settingModel: Model<WhatsappSetting>,
    private readonly api: WhatsappApiService,
  ) {}

  /**
   * The singleton settings row, created with schema defaults on first read so
   * the admin screen always has something to edit.
   */
  async getSettings(): Promise<WhatsappSetting> {
    const existing = await this.settingModel.findOne({
      key: WHATSAPP_SETTINGS_KEY,
    });
    if (existing) return existing;
    return this.settingModel.create({ key: WHATSAPP_SETTINGS_KEY });
  }

  async updateSettings(
    patch: Partial<WhatsappSetting>,
  ): Promise<WhatsappSetting> {
    await this.getSettings();
    const updated = await this.settingModel.findOneAndUpdate(
      { key: WHATSAPP_SETTINGS_KEY },
      { $set: patch },
      { new: true },
    );
    return updated as WhatsappSetting;
  }

  /**
   * Whether it's currently inside the configured opening hours, evaluated in
   * the configured timezone rather than the server's — the box runs UTC and
   * the business runs on IST.
   */
  private isWithinBusinessHours(settings: WhatsappSetting): boolean {
    if (!settings.businessHoursEnabled) return true;

    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: settings.timezone || 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
      }).formatToParts(new Date());

      const value = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? '';
      const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const day = weekdays.indexOf(value('weekday'));
      if (!settings.openDays?.includes(day)) return false;

      const minutes = Number(value('hour')) * 60 + Number(value('minute'));
      const [openH, openM] = (settings.openTime || '09:00')
        .split(':')
        .map(Number);
      const [closeH, closeM] = (settings.closeTime || '18:00')
        .split(':')
        .map(Number);
      const open = openH * 60 + openM;
      const close = closeH * 60 + closeM;

      // A close time earlier than the open time means the shift crosses midnight.
      return close >= open
        ? minutes >= open && minutes < close
        : minutes >= open || minutes < close;
    } catch (err) {
      // A bad timezone string shouldn't silence the acknowledgement.
      this.logger.warn(
        `Business-hours check failed (${(err as Error).message}) — treating as open`,
      );
      return true;
    }
  }

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

  /** Inbox list: every conversation, most recently active first. */
  async listConversations(): Promise<
    Array<Record<string, unknown> & { windowOpen: boolean }>
  > {
    const conversations = await this.conversationModel
      .find()
      // updatedAt, not lastInboundAt: a conversation we started with a template
      // has no inbound message yet and would otherwise sort to the bottom.
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean()
      .exec();

    return conversations.map((c) => ({
      ...c,
      windowOpen: this.isWindowOpen(c.lastInboundAt),
      windowExpiresAt: c.lastInboundAt
        ? new Date(new Date(c.lastInboundAt).getTime() + WINDOW_MS)
        : null,
    }));
  }

  /** One thread, oldest first so it reads top-to-bottom like a chat. */
  async getThread(contact: string, limit = 200): Promise<WhatsappMessage[]> {
    return this.messageModel
      .find({ contact })
      .sort({ sentAt: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .exec();
  }

  /**
   * Human reply from the admin inbox. Refuses up front when the 24-hour window
   * has closed — Meta would reject it anyway, and a clear message here beats a
   * Graph error code in the UI.
   */
  async replyTo(contact: string, body: string): Promise<WhatsappMessage> {
    const conversation = await this.conversationModel.findOne({ contact });
    if (!conversation) {
      throw new NotFoundException('No WhatsApp conversation with that number');
    }
    if (!this.isWindowOpen(conversation.lastInboundAt)) {
      throw new BadRequestException(
        'The 24-hour reply window has closed for this customer. ' +
          'Only an approved template message can be sent now.',
      );
    }
    return this.sendText(contact, body);
  }

  /**
   * Accepts a number the way a human types it and returns a wa_id — digits
   * only, country code included, which is the only form Meta takes.
   *
   * A bare 10-digit number is assumed Indian, since that's the whole customer
   * base; anything already carrying a country code is left alone.
   */
  normalizeContact(raw: string): string {
    const digits = (raw || '').replace(/\D/g, '');

    // "09876543210" — the trunk prefix people dial domestically.
    const trimmed =
      digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;

    const withCountry = trimmed.length === 10 ? `91${trimmed}` : trimmed;

    if (withCountry.length < 10 || withCountry.length > 15) {
      throw new BadRequestException(
        `"${raw}" is not a valid WhatsApp number. Include the country code, e.g. +91 98765 43210.`,
      );
    }
    return withCountry;
  }

  /**
   * Sends an approved template. Always allowed — this is how you reach someone
   * after the 24-hour window has closed.
   *
   * The thread stores the *rendered* text rather than the template name, so the
   * inbox reads like a conversation. The body is looked up from Meta since
   * templates aren't mirrored locally; if that lookup fails the send still goes
   * ahead and the row falls back to naming the template.
   */
  async sendTemplateTo(
    rawContact: string,
    input: SendTemplateInput,
  ): Promise<WhatsappMessage> {
    // A template can open a conversation with someone who has never written
    // in, so this is where numbers typed by hand first reach us.
    const contact = this.normalizeContact(rawContact);
    const now = new Date();
    const template = await this.findTemplate(input);
    const rendered = this.renderTemplate(input, template);

    try {
      const { waMessageId } = await this.api.sendTemplate(contact, {
        ...input,
        authentication: template?.category === 'AUTHENTICATION',
      });

      const [saved] = await Promise.all([
        this.messageModel.create({
          waMessageId,
          direction: WhatsappDirection.OUTBOUND,
          contact,
          from: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'business',
          to: contact,
          type: 'template',
          text: rendered,
          templateName: input.name,
          sentAt: now,
          sendStatus: WhatsappSendStatus.SENT,
          handled: true,
        }),
        this.conversationModel.updateOne(
          { contact },
          {
            $set: {
              lastOutboundAt: now,
              lastMessagePreview: rendered.slice(0, 200),
              lastMessageDirection: WhatsappDirection.OUTBOUND,
            },
            $setOnInsert: { contact },
          },
          { upsert: true },
        ),
      ]);
      this.logger.log(`Sent template "${input.name}" to ${contact}`);
      return saved;
    } catch (err) {
      await this.messageModel.create({
        waMessageId: `failed-${now.getTime()}-${contact}`,
        direction: WhatsappDirection.OUTBOUND,
        contact,
        from: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'business',
        to: contact,
        type: 'template',
        text: rendered,
        templateName: input.name,
        sentAt: now,
        sendStatus: WhatsappSendStatus.FAILED,
        errorMessage: (err as Error).message,
        handled: true,
      });
      throw err;
    }
  }

  /**
   * Looks the template up on Meta — we need its category to shape the send
   * (authentication templates need an extra button component) and its body to
   * render the thread. A lookup failure is not fatal: the send still goes
   * ahead, treated as a normal template.
   */
  private async findTemplate(
    input: SendTemplateInput,
  ): Promise<WhatsappTemplate | undefined> {
    try {
      const templates = await this.api.listTemplates();
      return templates.find(
        (t) => t.name === input.name && t.language === input.language,
      );
    } catch (err) {
      this.logger.warn(
        `Could not look up template "${input.name}": ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /** Fills a template's body with the given parameters, for the thread view. */
  private renderTemplate(
    input: SendTemplateInput,
    template?: WhatsappTemplate,
  ): string {
    const body = (template?.components ?? []).find(
      (c) => (c as { type?: string }).type === 'BODY',
    ) as { text?: string } | undefined;

    if (!body?.text) {
      // Authentication bodies are generated by Meta and often come back empty.
      return template?.category === 'AUTHENTICATION' && input.parameters?.[0]
        ? `${input.parameters[0]} is your verification code.`
        : `[template: ${input.name}]`;
    }

    return body.text.replace(/\{\{(\d+)\}\}/g, (whole, index: string) => {
      return input.parameters?.[Number(index) - 1] ?? whole;
    });
  }

  /**
   * Proxies inbound media. Meta's media URLs expire within minutes and require
   * the access token, so the browser can't fetch them directly — the admin UI
   * asks us and we stream the bytes back.
   */
  async getMedia(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.api.downloadMedia(mediaId);
  }

  /** Clears the inbox unread badge — local only, not a WhatsApp read receipt. */
  async markRead(
    contact: string,
  ): Promise<{ contact: string; unreadCount: 0 }> {
    await this.conversationModel.updateOne(
      { contact },
      { $set: { unreadCount: 0 } },
    );
    return { contact, unreadCount: 0 };
  }

  private isWindowOpen(lastInboundAt?: Date | null): boolean {
    if (!lastInboundAt) return false;
    return Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS;
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

    const contactInfo = (value.contacts ?? []).find(
      (c) => c.wa_id === message.from,
    );
    const media = this.extractMedia(message);

    const doc = {
      waMessageId: message.id,
      direction: WhatsappDirection.INBOUND,
      contact: message.from,
      from: message.from,
      profileName: contactInfo?.profile?.name,
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

    if (!result.upsertedCount) {
      this.logger.debug(`Duplicate delivery for ${message.id} ignored`);
      return;
    }

    this.logger.log(
      `Inbound WhatsApp ${doc.type} from ${doc.contact}` +
        (doc.text ? `: ${doc.text.slice(0, 120)}` : ''),
    );

    await this.conversationModel.updateOne(
      { contact: doc.contact },
      {
        $set: {
          profileName: doc.profileName,
          lastInboundAt: doc.sentAt,
          lastMessagePreview: doc.text?.slice(0, 200) ?? `[${doc.type}]`,
          lastMessageDirection: WhatsappDirection.INBOUND,
        },
        $inc: { unreadCount: 1 },
        $setOnInsert: { contact: doc.contact },
      },
      { upsert: true },
    );

    await this.sendAcknowledgementIfFirst(doc.contact);
  }

  /**
   * Sends the one-time acknowledgement, at most once per 24-hour customer
   * service window — so a customer firing off five messages gets one reply,
   * not five, while someone coming back next week is greeted again.
   *
   * The claim is a conditional update rather than a read-then-write: Meta can
   * deliver several messages concurrently, and two handlers both reading
   * "no ack yet" would each send one. Only the handler whose update matches
   * wins. A failed send clears the claim so the next message retries.
   */
  private async sendAcknowledgementIfFirst(contact: string): Promise<void> {
    if (!this.api.canSend) {
      this.logger.warn(
        'Outbound WhatsApp is not configured — skipping acknowledgement',
      );
      return;
    }

    const settings = await this.getSettings();
    if (!settings.autoReplyEnabled) return;

    const body = this.isWithinBusinessHours(settings)
      ? settings.acknowledgementText
      : settings.afterHoursText;
    if (!body?.trim()) return;

    const windowStart = new Date(Date.now() - WINDOW_MS);
    const claimed = await this.conversationModel.findOneAndUpdate(
      {
        contact,
        $or: [
          { ackSentAt: { $exists: false } },
          { ackSentAt: null },
          { ackSentAt: { $lt: windowStart } },
        ],
      },
      { $set: { ackSentAt: new Date() } },
    );
    if (!claimed) return;

    try {
      await this.sendText(contact, body, { automated: true });
      this.logger.log(`Sent acknowledgement to ${contact}`);
    } catch (err) {
      // Release the claim so the customer's next message tries again.
      await this.conversationModel.updateOne(
        { contact },
        { $unset: { ackSentAt: 1 } },
      );
      this.logger.error(
        `Acknowledgement to ${contact} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Sends a text message and records it as an OUTBOUND row so the admin inbox
   * shows the full thread. A send that Meta rejects is still recorded, with the
   * reason, rather than vanishing.
   */
  async sendText(
    to: string,
    body: string,
    opts: { automated?: boolean } = {},
  ): Promise<WhatsappMessage> {
    const now = new Date();
    try {
      const { waMessageId } = await this.api.sendText(to, body);

      const [saved] = await Promise.all([
        this.messageModel.create({
          waMessageId,
          direction: WhatsappDirection.OUTBOUND,
          contact: to,
          from: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'business',
          to,
          type: 'text',
          text: body,
          sentAt: now,
          sendStatus: WhatsappSendStatus.SENT,
          automated: opts.automated ?? false,
          handled: true,
        }),
        this.conversationModel.updateOne(
          { contact: to },
          {
            $set: {
              lastOutboundAt: now,
              lastMessagePreview: body.slice(0, 200),
              lastMessageDirection: WhatsappDirection.OUTBOUND,
            },
            $setOnInsert: { contact: to },
          },
          { upsert: true },
        ),
      ]);
      return saved;
    } catch (err) {
      const reason = (err as Error).message;
      await this.messageModel.create({
        // No wamid exists for a send Meta refused, so key the row locally.
        waMessageId: `failed-${now.getTime()}-${to}`,
        direction: WhatsappDirection.OUTBOUND,
        contact: to,
        from: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'business',
        to,
        type: 'text',
        text: body,
        sentAt: now,
        sendStatus: WhatsappSendStatus.FAILED,
        errorMessage: reason,
        automated: opts.automated ?? false,
        handled: true,
      });
      throw err;
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
