import {
  Injectable,
  Logger,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';

export interface TrackingEvent {
  timestamp: string; // ISO
  event: string; // e.g. "Item Dispatched"
  eventType: string; // e.g. "ItemDispatched"
  office: string;
  pincode: string;
  remarks: string;
}

export interface TrackingResult {
  consignmentNumber: string;
  /** true when a scrape succeeded and we have a page to read */
  available: boolean;
  /** true when we have a status (timeline or cached) for this article */
  found: boolean;
  /** true when only the cached summary is available (no live event timeline) */
  partial: boolean;
  message?: string;
  currentStatus: string;
  currentStatusType: string;
  delivered: boolean;
  bookedAt: string | null;
  deliveredAt: string | null;
  lastUpdatedAt: string | null;
  events: TrackingEvent[];
  articleType?: string;
  deliveryLocation?: string;
  source: string;
  fetchedAt: string;
}

/**
 * Scrapes India Post consignment status from myspeedpost.com.
 *
 * The site server-renders the tracking payload as JSON in the initial HTML, so
 * a single GET with a browser User-Agent + JSON extraction returns it — no
 * Livewire replay needed.
 *
 * Two shapes exist in that HTML:
 *  1. `tracking_events` — the full live event timeline (present when India Post
 *     upstream is reachable).
 *  2. A cached summary "cards" array (inside an Alpine `this.chunk([...])` call)
 *     that carries the LAST-KNOWN status (current_status, delivered_at, …) even
 *     when a live re-sync fails and the timeline is dropped.
 *
 * Note: the page ALWAYS contains a hidden "India Post Servers are down" banner
 * template, so its mere presence is NOT a reliable down signal — we never rely
 * on it. We prefer the timeline, fall back to the cached cards, and only report
 * "no info" when neither is present.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly BASE = 'https://myspeedpost.com/';
  private readonly UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  async track(consignmentNumber: string): Promise<TrackingResult> {
    const number = (consignmentNumber || '').trim().toUpperCase();
    // India Post format: 2 letters + 9 digits + 2 letters, e.g. EN409716859IN
    if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) {
      throw new BadRequestException(
        'Invalid consignment number. Expected 13 characters like EN409716859IN.',
      );
    }
    const html = await this.fetchPage(number);
    return this.parse(number, html);
  }

  private async fetchPage(number: string): Promise<string> {
    const url = `${this.BASE}?n=${encodeURIComponent(number)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: this.BASE,
        },
      });
      const body = await res.text();
      if (
        res.status === 403 ||
        /just a moment|cf-browser-verification|attention required/i.test(body)
      ) {
        throw new BadGatewayException(
          'Tracking source blocked the request (bot protection). Try again later.',
        );
      }
      if (!res.ok) {
        throw new BadGatewayException(
          `Tracking source returned HTTP ${res.status}.`,
        );
      }
      return body;
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new BadGatewayException('Tracking request timed out.');
      }
      if (e instanceof BadGatewayException) throw e;
      throw new BadGatewayException('Could not reach the tracking source.');
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(number: string, rawHtml: string): TrackingResult {
    const html = this.decodeEntities(rawHtml);
    const now = new Date().toISOString();

    // 1) Preferred: the full live event timeline.
    const eventsJson = this.extractJsonAfter('"tracking_events":', html);
    if (eventsJson) {
      let raw: any[] = [];
      try {
        raw = JSON.parse(eventsJson);
      } catch {
        raw = [];
      }
      if (raw.length) {
        const events: TrackingEvent[] = raw.map((e) => ({
          timestamp: e.tracked_at,
          event: e.event,
          eventType: e.event_type,
          office: e.office,
          pincode: String(e.pincode ?? ''),
          remarks: e.remarks || '',
        }));
        const first = events[0];
        const last = events[events.length - 1];
        const deliveredEvent = [...events]
          .reverse()
          .find(
            (e) => /deliver/i.test(e.eventType) || /delivered/i.test(e.event),
          );
        return {
          consignmentNumber: number,
          available: true,
          found: true,
          partial: false,
          currentStatus: last?.event ?? 'Unknown',
          currentStatusType: last?.eventType ?? 'Unknown',
          delivered: !!deliveredEvent,
          bookedAt: first?.timestamp ?? null,
          deliveredAt: deliveredEvent?.timestamp ?? null,
          lastUpdatedAt: last?.timestamp ?? null,
          events,
          source: 'myspeedpost.com',
          fetchedAt: now,
        };
      }
    }

    // 2) Fallback: cached summary cards (last-known status when a live re-sync
    // isn't possible). Reliably anchored on the Alpine `this.chunk([...])` call.
    const cards = this.extractCards(html);
    const card = (k: string) =>
      cards?.find((c) => c.key === k)?.value ?? null;
    const rawStatus = (card('current_status') || '').toString().trim();
    if (rawStatus) {
      // Strip a leading status emoji (e.g. "✅ Item Delivered") — the UI adds its own icon.
      const currentStatus =
        rawStatus.replace(/^[^\p{L}\p{N}]+/u, '').trim() || rawStatus;
      const delivered = /deliver/i.test(currentStatus) || !!card('delivered_at');
      return {
        consignmentNumber: number,
        available: true,
        found: true,
        partial: true,
        message:
          'Live event timeline is temporarily unavailable — showing the last synced status.',
        currentStatus,
        currentStatusType: delivered ? 'Delivered' : 'InTransit',
        delivered,
        bookedAt: card('booked_on'),
        deliveredAt: card('delivered_at'),
        lastUpdatedAt: card('last_updated_at'),
        events: [],
        articleType: (card('article_type_text') as string) || undefined,
        deliveryLocation: (card('delivery_location') as string) || undefined,
        source: 'myspeedpost.com',
        fetchedAt: now,
      };
    }

    // 3) Neither a timeline nor a cached status exists for this number.
    return {
      consignmentNumber: number,
      available: true,
      found: false,
      partial: false,
      message: 'No tracking information found for this number yet.',
      currentStatus: 'No tracking information found yet',
      currentStatusType: 'Unknown',
      delivered: false,
      bookedAt: null,
      deliveredAt: null,
      lastUpdatedAt: null,
      events: [],
      source: 'myspeedpost.com',
      fetchedAt: now,
    };
  }

  private extractCards(
    html: string,
  ): Array<{ key: string; value: any }> | null {
    const arr = this.extractJsonAfter('this.chunk(', html);
    if (!arr) return null;
    try {
      return JSON.parse(arr);
    } catch {
      return null;
    }
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** Bracket-matches the JSON array/object that immediately follows `key`. */
  private extractJsonAfter(key: string, s: string): string | null {
    const i = s.indexOf(key);
    if (i < 0) return null;
    let j = i + key.length;
    while (j < s.length && /\s/.test(s[j])) j++;
    const open = s[j];
    if (open !== '[' && open !== '{') return null;
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = j; k < s.length; k++) {
      const c = s[k];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return s.slice(j, k + 1);
      }
    }
    return null;
  }
}
