import {
  Injectable,
  Logger,
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

/** One row of `booking_details` from the Bulk Tracking API. */
export interface IndiaPostBookingDetails {
  article_number: string;
  booked_at?: string;
  /** Null for an article India Post has no booking record for. */
  booked_on?: string | null;
  origin_pincode?: string | number;
  destination_pincode?: string | number;
  tariff?: number;
  article_type?: string;
  delivery_location?: string;
  delivery_confirmed_on?: string | null;
}

/**
 * One scan in `tracking_details`.
 *
 * Verified against the live UAT API, which is looser than the integration
 * document: `date` carries the day with the clock zeroed and the real time
 * lives in `time`; `officeid` comes back as a number; and `remarks`/`rts` are
 * absent from every entry even though the document shows them.
 */
export interface IndiaPostTrackingEvent {
  date: string;
  time?: string;
  office?: string;
  officeid?: string | number;
  event: string;
  remarks?: string;
  /** Returned to sender. Documented, but not sent by the UAT API. */
  rts?: boolean;
}

export interface IndiaPostArticle {
  booking_details?: IndiaPostBookingDetails;
  tracking_details?: IndiaPostTrackingEvent[];
  del_status?: { del_status?: string };
}

interface LoginResponse {
  success?: boolean;
  message?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };
}

interface BulkTrackingResponse {
  status_code?: number;
  success?: boolean;
  message?: string;
  data?: IndiaPostArticle[];
}

const REQUEST_TIMEOUT_MS = 20_000;
/** Renew this far before the token actually lapses, to survive clock skew. */
const TOKEN_SKEW_MS = 60_000;
/** The doc promises 15 minutes; used only when `expires_in` is absent. */
const DEFAULT_TOKEN_TTL_S = 15 * 60;
/** The Bulk Tracking API accepts at most 500 article numbers per call. */
export const MAX_ARTICLES_PER_CALL = 500;

/**
 * Client for India Post's external-integration APIs (CEPT "beextcustomer").
 *
 * Owns the credentials, the bearer-token lifecycle and the HTTP concerns;
 * `TrackingService` maps the responses onto our own shapes.
 *
 * Config (`.env`):
 *  - `INDIAPOST_BASE_URL` — defaults to the UAT host
 *    (`https://test.cept.gov.in/beextcustomer`). Point it at the production
 *    host once India Post issues production credentials.
 *  - `INDIAPOST_USERNAME` / `INDIAPOST_PASSWORD` — login for /v1/access/login.
 *
 * Two things to know before expecting live data:
 *  1. India Post only returns articles **booked under the same customer id** as
 *     the credentials. Parcels we booked outside this integration are invisible
 *     to it, and UAT credentials only see UAT articles.
 *  2. Production access additionally requires our server's static IP to be
 *     whitelisted by India Post.
 */
@Injectable()
export class IndiaPostApiService {
  private readonly logger = new Logger(IndiaPostApiService.name);

  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** De-duplicates concurrent logins so a burst of requests logs in once. */
  private loginInFlight: Promise<string> | null = null;

  private get baseUrl(): string {
    return (
      process.env.INDIAPOST_BASE_URL || 'https://test.cept.gov.in/beextcustomer'
    ).replace(/\/+$/, '');
  }

  /** True when credentials exist at all — lets callers fail with a clear message. */
  get configured(): boolean {
    return Boolean(
      process.env.INDIAPOST_USERNAME && process.env.INDIAPOST_PASSWORD,
    );
  }

  private requireCredentials(): { username: string; password: string } {
    const username = process.env.INDIAPOST_USERNAME;
    const password = process.env.INDIAPOST_PASSWORD;
    if (!username || !password) {
      throw new ServiceUnavailableException(
        'India Post tracking is not configured — set INDIAPOST_USERNAME and INDIAPOST_PASSWORD',
      );
    }
    return { username, password };
  }

  /**
   * Tracking for up to 500 article numbers per upstream call; longer lists are
   * chunked. Articles India Post has nothing for are simply absent from the
   * result, so callers match on `booking_details.article_number`.
   */
  async trackBulk(articleNumbers: string[]): Promise<IndiaPostArticle[]> {
    const numbers = [
      ...new Set(
        articleNumbers
          .map((n) => (n || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!numbers.length) return [];

    const results: IndiaPostArticle[] = [];
    for (let i = 0; i < numbers.length; i += MAX_ARTICLES_PER_CALL) {
      const chunk = numbers.slice(i, i + MAX_ARTICLES_PER_CALL);
      const body = await this.request<BulkTrackingResponse>(
        '/v1/tracking/bulk',
        { method: 'POST', body: { bulk: chunk } },
      );
      if (body.success === false) {
        throw new BadGatewayException(
          body.message || 'India Post rejected the tracking request',
        );
      }
      results.push(...(body.data ?? []));
    }
    return results;
  }

  /**
   * Cached bearer token. India Post tokens live ~15 minutes, so this refreshes
   * on expiry rather than logging in per request.
   */
  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const { username, password } = this.requireCredentials();
    const url = `${this.baseUrl}/v1/access/login`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`India Post login failed: ${reason}`);
      throw new BadGatewayException(`India Post unreachable: ${reason}`);
    }

    const text = await res.text();
    let parsed: LoginResponse = {};
    try {
      parsed = text ? (JSON.parse(text) as LoginResponse) : {};
    } catch {
      parsed = {};
    }

    const token = parsed.data?.access_token;
    if (!res.ok || !token) {
      const detail =
        parsed.message || text.slice(0, 300) || `HTTP ${res.status}`;
      this.logger.error(`India Post login → ${res.status}: ${detail}`);
      // Bad credentials are our configuration problem, not India Post's outage.
      throw res.status === 401 || res.status === 403
        ? new ServiceUnavailableException(
            'India Post rejected our credentials — check INDIAPOST_USERNAME / INDIAPOST_PASSWORD',
          )
        : new BadGatewayException(`India Post login failed: ${detail}`);
    }

    const ttl = Number(parsed.data?.expires_in) || DEFAULT_TOKEN_TTL_S;
    this.token = token;
    this.tokenExpiresAt = Date.now() + Math.max(ttl * 1000 - TOKEN_SKEW_MS, 0);
    this.logger.log(`India Post token acquired (valid ~${ttl}s)`);
    return token;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
    retriedAfterAuthFailure = false,
  ): Promise<T> {
    const token = await this.accessToken();
    const url = `${this.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`India Post ${path} failed: ${reason}`);
      throw new BadGatewayException(`India Post unreachable: ${reason}`);
    }

    // A token can lapse between the expiry check and the call landing; log in
    // again once before giving up.
    if (
      (res.status === 401 || res.status === 403) &&
      !retriedAfterAuthFailure
    ) {
      this.logger.warn(`India Post ${path} → ${res.status}; refreshing token`);
      this.token = null;
      await this.accessToken(true);
      return this.request<T>(path, init, true);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const detail =
        (parsed as { message?: string }).message ||
        text.slice(0, 300) ||
        `HTTP ${res.status}`;
      this.logger.error(`India Post ${path} → ${res.status}: ${detail}`);
      throw res.status >= 400 && res.status < 500
        ? new BadRequestException(detail)
        : new BadGatewayException(detail);
    }

    return parsed as T;
  }
}
