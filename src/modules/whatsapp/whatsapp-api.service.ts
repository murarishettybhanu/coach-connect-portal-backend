import {
  Injectable,
  Logger,
  HttpException,
  PayloadTooLargeException,
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface SendTextResult {
  /** WhatsApp's id for the message we just sent (`wamid.…`). */
  waMessageId: string;
}

/** One day of Meta pricing analytics for one pricing category. */
export interface PricingPoint {
  start: number;
  end: number;
  volume?: number;
  cost?: number;
  pricing_category?: string;
}

/** One day of Meta template analytics for one template. */
export interface TemplatePoint {
  template_id: string;
  start: number;
  end: number;
  sent?: number;
  delivered?: number;
  read?: number;
  clicked?: { type: string; button_content?: string; count: number }[];
  cost?: { type: string; value: number }[];
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
  /**
   * Values for a template written with *named* placeholders ({{customer_name}}).
   * Meta treats the two styles differently on the wire, so a template declares
   * one or the other and the caller supplies the matching shape.
   */
  namedParameters?: Record<string, string>;
  /**
   * Image for a template whose HEADER is media. Such a template must carry a
   * header component on EVERY send — the approved sample is not reused — and
   * Meta rejects the whole message with 132012 if it's missing.
   */
  headerImageUrl?: string;

  /**
   * Values for a TEXT header carrying its own named placeholder, e.g. a header
   * reading "Dispatch Update {{date}}". Ignored when `headerImageUrl` is set,
   * since a header is either media or text, never both.
   */
  headerNamedParameters?: Record<string, string>;

  /**
   * Set for AUTHENTICATION templates. They need the passcode repeated in a
   * button component as well as the body — without it Meta rejects the send,
   * since the copy-code button has nothing to copy.
   */
  authentication?: boolean;

  /**
   * Prebuilt `components` (from `buildTemplateComponents`, which reads the
   * template's own fields). When set, every other value field above is ignored.
   */
  components?: Record<string, unknown>[];

  /** Admin dialog values keyed by field (`body.customer_name`, `header.media` …) — see template-fields.ts. */
  values?: Record<string, string>;
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
 * Inbound media cap. WhatsApp's own limits top out at 16MB for video and
 * 100MB for documents; anything over this is refused rather than buffered in
 * memory on a t3.micro.
 */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * Hosts Meta serves media downloads from (`lookaside.fbsbx.com` today). The
 * bearer token goes only to these: the URL comes out of a Graph response, and
 * a token sent anywhere else would be a leaked credential.
 */
const MEDIA_HOST_SUFFIXES = ['.fbsbx.com', '.whatsapp.net'];

export function isMetaMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

/**
 * Turns a failed upstream call into a client-safe exception. Meta's own
 * wording can carry account and template internals, so it goes to the log and
 * rides along as `upstreamDetail` (recorded on failed inbox rows, which only
 * admins see) — never into the HTTP response.
 *
 * 401/403 mean *our* token or permissions are wrong, which is a server-side
 * configuration fault, not the caller's — 503, not 400.
 */
function upstreamError(
  status: number,
  detail: string,
  code?: number,
): HttpException {
  const ref = code ? ` (error ${code})` : '';
  const err =
    status === 401 || status === 403
      ? new ServiceUnavailableException(
          'WhatsApp is not authorised — check the access token and its permissions',
        )
      : status >= 400 && status < 500
        ? new BadRequestException(`WhatsApp rejected the request${ref}`)
        : new BadGatewayException(`WhatsApp is unavailable right now${ref}`);
  return Object.assign(err, { upstreamDetail: detail });
}

/**
 * Meta's cap on a named template parameter. It is enforced on SEND, not on
 * template creation — a template approved with a longer name looks healthy in
 * WhatsApp Manager and then fails every send with a 400. Checking here turns
 * that into an error naming the offending parameter, at the call site.
 */
const MAX_PARAMETER_NAME = 20;

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
   * Interactive message (reply buttons, CTA URL or list). Free-form, so only
   * inside the 24-hour window — callers check it.
   */
  async sendInteractive(
    to: string,
    interactive: Record<string, unknown>,
  ): Promise<SendTextResult> {
    const data = await this.request<{ messages?: Array<{ id?: string }> }>(
      `${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive,
        },
      },
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
   * Uploads a file to Meta for this number and returns its media id. Media
   * uploaded this way can be sent (and downloaded again) for 30 days.
   */
  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      filename,
    );

    const path = `${this.phoneNumberId}/media`;
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${this.version}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
        // Bigger than a JSON call: up to 16 MB going out.
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`Graph API media upload failed: ${reason}`);
      throw Object.assign(new BadGatewayException('WhatsApp API unreachable'), {
        upstreamDetail: `WhatsApp API unreachable: ${reason}`,
      });
    }
    const text = await res.text();
    let parsed: { id?: string; error?: GraphError['error'] } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok || !parsed.id) {
      const detail =
        parsed.error?.error_user_msg ||
        parsed.error?.message ||
        text.slice(0, 300) ||
        `HTTP ${res.status}`;
      this.logger.error(`Graph API ${path} → ${res.status}: ${detail}`);
      throw upstreamError(
        res.ok ? 502 : res.status,
        detail,
        parsed.error?.code,
      );
    }
    return parsed.id;
  }

  /**
   * Sends uploaded media. Like free-form text, only inside the 24-hour window.
   * Audio takes no caption; a document carries its filename for the customer.
   */
  async sendMedia(
    to: string,
    kind: 'image' | 'video' | 'audio' | 'document',
    mediaId: string,
    opts: { caption?: string; filename?: string } = {},
  ): Promise<SendTextResult> {
    const media: Record<string, string> = { id: mediaId };
    if (opts.caption && kind !== 'audio') media.caption = opts.caption;
    if (kind === 'document' && opts.filename) media.filename = opts.filename;
    const data = await this.request<{ messages?: Array<{ id?: string }> }>(
      `${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: kind,
          [kind]: media,
        },
      },
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
    this.assertParameterNames(input);
    const components: Record<string, unknown>[] = input.components
      ? [...input.components]
      : [];

    if (input.components) {
      // Already built from the template's fields.
    } else if (input.headerImageUrl) {
      components.push({
        type: 'header',
        parameters: [{ type: 'image', image: { link: input.headerImageUrl } }],
      });
    } else if (input.headerNamedParameters) {
      // A TEXT header with its own placeholder ({{date}}) needs a header
      // component of its own; body parameters don't fill it.
      components.push({
        type: 'header',
        parameters: Object.entries(input.headerNamedParameters).map(
          ([parameter_name, text]) => ({ type: 'text', parameter_name, text }),
        ),
      });
    }

    const named = input.namedParameters
      ? Object.entries(input.namedParameters)
      : [];

    if (named.length) {
      components.push({
        type: 'body',
        parameters: named.map(([parameter_name, text]) => ({
          type: 'text',
          parameter_name,
          text,
        })),
      });
    } else if (input.parameters?.length) {
      components.push({
        type: 'body',
        parameters: input.parameters.map((text) => ({ type: 'text', text })),
      });

      // Authentication templates carry the same code twice: once in the body
      // and once as the OTP button's payload. Meta spells the button's
      // sub_type 'url' even for a copy-code button.
      if (input.authentication) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: input.parameters[0] }],
        });
      }
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        ...(components.length ? { components } : {}),
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
    // Graph ids are numeric; anything else would be a path into another
    // Graph endpoint, called with our token.
    if (!/^\d+$/.test(mediaId)) {
      throw new BadRequestException('Invalid media id');
    }
    const meta = await this.request<{
      url?: string;
      mime_type?: string;
      file_size?: number;
    }>(mediaId, { method: 'GET' });
    if (!meta.url) {
      throw new BadGatewayException(
        'WhatsApp returned no download URL for that media',
      );
    }
    if (!isMetaMediaUrl(meta.url)) {
      this.logger.error(
        `Refusing media download for ${mediaId} from an unexpected host`,
      );
      throw new BadGatewayException('Could not download WhatsApp media');
    }
    if (Number(meta.file_size) > MAX_MEDIA_BYTES) {
      throw new PayloadTooLargeException('That media file is too large');
    }

    let res: Response;
    try {
      res = await this.fetchMedia(meta.url);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Media download for ${mediaId} failed: ${(err as Error).message}`,
      );
      throw new BadGatewayException('Could not download WhatsApp media');
    }

    if (!res.ok) {
      this.logger.error(`Media download for ${mediaId} → ${res.status}`);
      throw new BadGatewayException(
        `Could not download WhatsApp media (${res.status})`,
      );
    }

    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_MEDIA_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new PayloadTooLargeException('That media file is too large');
    }

    return {
      // Counted as it streams too: content-length can be absent or wrong.
      buffer: await this.readCapped(res, MAX_MEDIA_BYTES),
      mimeType:
        meta.mime_type ||
        res.headers.get('content-type') ||
        'application/octet-stream',
    };
  }

  /**
   * Fetches with the bearer token, following redirects by hand so every hop
   * is checked against the Meta host list before the token is sent to it.
   */
  private async fetchMedia(url: string, hops = 0): Promise<Response> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url).toString();
      if (hops >= 3 || !isMetaMediaUrl(next)) {
        this.logger.error('Refusing a media redirect to an unexpected host');
        throw new BadGatewayException('Could not download WhatsApp media');
      }
      return this.fetchMedia(next, hops + 1);
    }
    return res;
  }

  private async readCapped(res: Response, cap: number): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeException('That media file is too large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  /**
   * One template by its Meta id. The send API takes a *name* and language, so
   * anything configured by id (the OTP template) has to be resolved first.
   */
  async getTemplateById(id: string): Promise<WhatsappTemplate> {
    return this.request<WhatsappTemplate>(
      `${id}?fields=id,name,language,category,status,components`,
      { method: 'GET' },
    );
  }

  /**
   * GET with Meta's cursor paging followed (`paging.next`), concatenating
   * `pick(page)` from every page. Capped so a runaway cursor can't loop.
   */
  private async getAllPages<T>(
    path: string,
    pick: (page: any) => T[],
    maxPages = 20,
  ): Promise<T[]> {
    const out: T[] = [];
    let page: any = await this.request<any>(path, { method: 'GET' });
    for (let i = 0; page && i < maxPages; i++) {
      out.push(...pick(page));
      const next: string | undefined = page?.paging?.next;
      if (!next) break;
      // `next` is a full URL on graph.facebook.com — strip the host/version.
      const rel = next.replace(
        /^https:\/\/graph\.facebook\.com\/v[\d.]+\//,
        '',
      );
      page = await this.request<any>(rel, { method: 'GET' });
    }
    return out;
  }

  /**
   * Meta's per-message pricing analytics for the WABA: daily points of
   * { start, end, volume, cost, pricing_category }. Ranges over a few months
   * are refused, so callers ask month by month.
   */
  async pricingAnalytics(start: number, end: number): Promise<PricingPoint[]> {
    const field = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY"])`;
    const data = await this.request<{
      pricing_analytics?: { data?: { data_points?: PricingPoint[] }[] };
    }>(`${this.wabaId}?fields=${encodeURIComponent(field)}`, { method: 'GET' });
    return (data.pricing_analytics?.data ?? []).flatMap(
      (d) => d.data_points ?? [],
    );
  }

  /**
   * Per-template daily analytics (sent, delivered, read, clicks, cost). Meta
   * takes at most 10 template ids per call and pages the result.
   */
  async templateAnalytics(
    templateIds: string[],
    start: number,
    end: number,
  ): Promise<TemplatePoint[]> {
    const out: TemplatePoint[] = [];
    for (let i = 0; i < templateIds.length; i += 10) {
      const q = new URLSearchParams({
        start: String(start),
        end: String(end),
        granularity: 'DAILY',
        template_ids: JSON.stringify(templateIds.slice(i, i + 10)),
        metric_types: JSON.stringify([
          'COST',
          'SENT',
          'DELIVERED',
          'READ',
          'CLICKED',
        ]),
      });
      out.push(
        ...(await this.getAllPages<TemplatePoint>(
          `${this.wabaId}/template_analytics?${q}`,
          (page) => (page?.data ?? []).flatMap((d: any) => d.data_points ?? []),
        )),
      );
    }
    return out;
  }

  /** The WABA's billing currency (e.g. INR). */
  async accountCurrency(): Promise<string> {
    const data = await this.request<{ currency?: string }>(
      `${this.wabaId}?fields=currency`,
      { method: 'GET' },
    );
    return data.currency || 'INR';
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

  /**
   * Fails a send whose named parameters Meta would reject, before spending the
   * round trip — and with a message that says which name and how long it is,
   * rather than Meta's context-free "must be at most 20 characters long".
   */
  private assertParameterNames(input: SendTemplateInput): void {
    const names = [
      ...Object.keys(input.namedParameters ?? {}),
      ...Object.keys(input.headerNamedParameters ?? {}),
    ];
    const tooLong = names.filter((n) => n.length > MAX_PARAMETER_NAME);
    if (tooLong.length) {
      const detail = tooLong.map((n) => `"${n}" (${n.length})`).join(', ');
      throw new BadRequestException(
        `Template "${input.name}" has parameter names over ${MAX_PARAMETER_NAME} characters: ${detail}. ` +
          'Rename the variable in WhatsApp Manager — Meta accepts these at template creation but rejects every send.',
      );
    }
  }

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
      throw Object.assign(new BadGatewayException('WhatsApp API unreachable'), {
        upstreamDetail: `WhatsApp API unreachable: ${reason}`,
      });
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
      // template); 5xx is theirs; 401/403 is our configuration.
      throw upstreamError(res.status, detail, graphError?.code);
    }

    return parsed as T;
  }
}
