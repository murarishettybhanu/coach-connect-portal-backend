import {
  Injectable,
  Logger,
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface SendTextResult {
  /** WhatsApp's id for the message we just sent (`wamid.…`). */
  waMessageId: string;
}

export interface WhatsappTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  // APPROVED | PENDING | REJECTED | PAUSED | DISABLED
  status: string;
  components?: unknown[];
  rejected_reason?: string;
}

export interface SendTemplateInput {
  name: string;
  language: string;
  /** Values for the template's {{1}}, {{2}} … body placeholders, in order. */
  parameters?: string[];
}

export interface MediaFile {
  buffer: Buffer;
  mimeType: string;
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
  };
}

const GRAPH_TIMEOUT_MS = 10_000;

/**
 * Thin client for the Meta Graph API — everything we send *to* WhatsApp.
 *
 * Kept separate from `WhatsappService` (which owns the inbound webhook and
 * persistence) so the outbound credentials and HTTP concerns live in one place.
 *
 * Config (`.env`):
 *  - `WHATSAPP_ACCESS_TOKEN` — permanent System User token with
 *    `whatsapp_business_messaging` + `whatsapp_business_management`.
 *  - `WHATSAPP_PHONE_NUMBER_ID` — the sending number; part of the send URL.
 *  - `WHATSAPP_WABA_ID` — WhatsApp Business Account id; needed for templates only.
 *  - `WHATSAPP_API_VERSION` — Graph version, defaults to v21.0.
 */
@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);

  private get version(): string {
    return process.env.WHATSAPP_API_VERSION || 'v21.0';
  }

  private get token(): string {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
      throw new ServiceUnavailableException(
        'WHATSAPP_ACCESS_TOKEN is not configured — cannot send WhatsApp messages',
      );
    }
    return token;
  }

  private get phoneNumberId(): string {
    const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!id) {
      throw new ServiceUnavailableException(
        'WHATSAPP_PHONE_NUMBER_ID is not configured — cannot send WhatsApp messages',
      );
    }
    return id;
  }

  private get wabaId(): string {
    const id = process.env.WHATSAPP_WABA_ID;
    if (!id) {
      throw new ServiceUnavailableException(
        'WHATSAPP_WABA_ID is not configured — cannot manage message templates',
      );
    }
    return id;
  }

  /** True when sending is configured at all — lets callers skip quietly. */
  get canSend(): boolean {
    return Boolean(
      process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID,
    );
  }

  /**
   * Free-form text message. Only allowed inside WhatsApp's 24-hour customer
   * service window — outside it Meta rejects the send and only an approved
   * template will go through. Callers check the window first.
   */
  async sendText(to: string, body: string): Promise<SendTextResult> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    };

    const data = await this.request<{ messages?: Array<{ id?: string }> }>(
      `${this.phoneNumberId}/messages`,
      { method: 'POST', body: payload },
    );

    const waMessageId = data.messages?.[0]?.id;
    if (!waMessageId) {
      throw new BadGatewayException(
        'WhatsApp accepted the send but returned no message id',
      );
    }
    return { waMessageId };
  }

  /**
   * Template message — the only thing Meta accepts once the 24-hour window has
   * closed. Body placeholders are positional, so `parameters` must be in
   * {{1}}, {{2}} … order.
   */
  async sendTemplate(
    to: string,
    input: SendTemplateInput,
  ): Promise<SendTextResult> {
    const components = input.parameters?.length
      ? [
          {
            type: 'body',
            parameters: input.parameters.map((text) => ({
              type: 'text',
              text,
            })),
          },
        ]
      : undefined;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        ...(components ? { components } : {}),
      },
    };

    const data = await this.request<{ messages?: Array<{ id?: string }> }>(
      `${this.phoneNumberId}/messages`,
      { method: 'POST', body: payload },
    );

    const waMessageId = data.messages?.[0]?.id;
    if (!waMessageId) {
      throw new BadGatewayException(
        'WhatsApp accepted the template send but returned no message id',
      );
    }
    return { waMessageId };
  }

  /**
   * Downloads inbound media. Two hops by design: the id resolves to a URL that
   * expires in minutes, and that URL still needs the bearer token — so media
   * can't be linked to directly from a browser and has to be proxied.
   */
  async downloadMedia(mediaId: string): Promise<MediaFile> {
    const meta = await this.request<{ url?: string; mime_type?: string }>(
      mediaId,
      { method: 'GET' },
    );
    if (!meta.url) {
      throw new BadGatewayException(
        'WhatsApp returned no download URL for that media',
      );
    }

    let res: Response;
    try {
      res = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BadGatewayException(
        `Could not download WhatsApp media: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      this.logger.error(`Media download for ${mediaId} → ${res.status}`);
      throw new BadGatewayException(
        `Could not download WhatsApp media (${res.status})`,
      );
    }

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType:
        meta.mime_type ||
        res.headers.get('content-type') ||
        'application/octet-stream',
    };
  }

  /** Message templates on the WABA, newest first as Meta returns them. */
  async listTemplates(): Promise<WhatsappTemplate[]> {
    const data = await this.request<{ data?: WhatsappTemplate[] }>(
      `${this.wabaId}/message_templates?limit=200`,
      { method: 'GET' },
    );
    return data.data ?? [];
  }

  /**
   * Submits a template for review. Meta approves most in minutes, but it can
   * take up to a day — the returned status is normally PENDING.
   */
  async createTemplate(input: CreateTemplateInput): Promise<WhatsappTemplate> {
    return this.request<WhatsappTemplate>(`${this.wabaId}/message_templates`, {
      method: 'POST',
      body: input,
    });
  }

  async deleteTemplate(name: string): Promise<void> {
    await this.request(
      `${this.wabaId}/message_templates?name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * One place for Graph calls: auth header, timeout, and turning Meta's error
   * envelope into a Nest exception. Meta puts the useful sentence in
   * `error_user_msg`, falling back to `message`.
   */
  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    const url = `https://graph.facebook.com/${this.version}/${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`Graph API request to ${path} failed: ${reason}`);
      throw new BadGatewayException(`WhatsApp API unreachable: ${reason}`);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const graphError = (parsed as GraphError).error;
      const detail =
        graphError?.error_user_msg ||
        graphError?.message ||
        text.slice(0, 300) ||
        `HTTP ${res.status}`;
      this.logger.error(`Graph API ${path} → ${res.status}: ${detail}`);

      // 4xx from Meta is our mistake (bad number, closed window, malformed
      // template); 5xx is theirs.
      throw res.status >= 400 && res.status < 500
        ? new BadRequestException(detail)
        : new BadGatewayException(detail);
    }

    return parsed as T;
  }
}
