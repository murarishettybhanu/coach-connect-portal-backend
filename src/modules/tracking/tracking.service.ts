import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  IndiaPostApiService,
  IndiaPostArticle,
  IndiaPostTrackingEvent,
} from './india-post-api.service';

export interface TrackingEvent {
  timestamp: string; // ISO
  event: string; // e.g. "Item Dispatched"
  eventType: string; // e.g. "ItemDispatched"
  office: string;
  pincode: string;
  remarks: string;
  /** India Post flagged this scan as "returned to sender". */
  rts: boolean;
}

export interface TrackingResult {
  consignmentNumber: string;
  /** true when the upstream call succeeded and we have an answer to read */
  available: boolean;
  /** true when India Post knows this article */
  found: boolean;
  /** true when the booking is known but no scans have been recorded yet */
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
  /** Office the article was booked at. */
  bookedAtOffice?: string;
  originPincode?: string;
  destinationPincode?: string;
  /** What India Post charged for the article, in INR. */
  tariff?: number;
  /** True once any scan is flagged return-to-sender. */
  returnToSender: boolean;
  source: string;
  fetchedAt: string;
}

// India Post format: 2 letters + 9 digits + 2 letters, e.g. EN409716859IN
const ARTICLE_NUMBER_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const SOURCE = 'India Post';

/**
 * Consignment status from India Post's official Bulk Tracking API
 * (`POST /v1/tracking/bulk`), mapped onto our own shape.
 *
 * India Post returns only articles booked under the same customer id as the
 * configured credentials, so an article we booked outside this integration
 * comes back as "not found" rather than as an error. See
 * `IndiaPostApiService` for the credentials and host configuration.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(private readonly indiaPost: IndiaPostApiService) {}

  async track(consignmentNumber: string): Promise<TrackingResult> {
    const number = this.normalize(consignmentNumber);
    const [result] = await this.trackMany([number]);
    return result;
  }

  /**
   * Tracking for several articles in one upstream round trip — the shape the
   * India Post API is actually built for (up to 500 per call).
   */
  async trackMany(consignmentNumbers: string[]): Promise<TrackingResult[]> {
    const numbers = consignmentNumbers.map((n) => this.normalize(n));
    if (!numbers.length) return [];

    const articles = await this.indiaPost.trackBulk(numbers);

    // Index the response by article number; India Post omits what it doesn't know.
    const byNumber = new Map<string, IndiaPostArticle>();
    for (const article of articles) {
      const key = (article.booking_details?.article_number || '')
        .trim()
        .toUpperCase();
      if (key) byNumber.set(key, article);
    }

    return numbers.map((number) => this.map(number, byNumber.get(number)));
  }

  private normalize(consignmentNumber: string): string {
    const number = (consignmentNumber || '').trim().toUpperCase();
    if (!ARTICLE_NUMBER_RE.test(number)) {
      throw new BadRequestException(
        'Invalid consignment number. Expected 13 characters like EN409716859IN.',
      );
    }
    return number;
  }

  private map(number: string, article?: IndiaPostArticle): TrackingResult {
    const now = new Date().toISOString();
    const base = {
      consignmentNumber: number,
      available: true,
      source: SOURCE,
      fetchedAt: now,
    };

    const booking = article?.booking_details;
    const events = this.mapEvents(article?.tracking_details ?? []);

    if (!booking && !events.length) {
      return {
        ...base,
        found: false,
        partial: false,
        message:
          'No tracking information found for this number yet. India Post only reports articles booked under our customer id.',
        currentStatus: 'No tracking information found yet',
        currentStatusType: 'Unknown',
        delivered: false,
        bookedAt: null,
        deliveredAt: null,
        lastUpdatedAt: null,
        events: [],
        returnToSender: false,
      };
    }

    const last = events[events.length - 1];
    const first = events[0];

    // "not delivered" contains the word, so a plain /deliver/ test isn't enough.
    const delStatus = (article?.del_status?.del_status || '').trim();
    const deliveredByStatus =
      /deliver/i.test(delStatus) && !/^not\b/i.test(delStatus);
    const deliveredEvent = [...events]
      .reverse()
      .find((e) => /delivered/i.test(e.event));
    const delivered = Boolean(
      deliveredByStatus || booking?.delivery_confirmed_on || deliveredEvent,
    );

    const currentStatus =
      last?.event || (booking ? 'Booked — awaiting first scan' : 'Unknown');

    return {
      ...base,
      found: true,
      // Booked, but India Post has recorded no scans against it yet.
      partial: !events.length,
      message: events.length
        ? undefined
        : 'Booked with India Post — no scans recorded against it yet.',
      currentStatus,
      currentStatusType: last?.eventType || 'Booked',
      delivered,
      bookedAt: booking?.booked_on || first?.timestamp || null,
      deliveredAt:
        booking?.delivery_confirmed_on || deliveredEvent?.timestamp || null,
      lastUpdatedAt: last?.timestamp || booking?.booked_on || null,
      events,
      articleType: booking?.article_type || undefined,
      deliveryLocation: booking?.delivery_location || undefined,
      bookedAtOffice: booking?.booked_at || undefined,
      originPincode: this.str(booking?.origin_pincode),
      destinationPincode: this.str(booking?.destination_pincode),
      tariff: typeof booking?.tariff === 'number' ? booking.tariff : undefined,
      returnToSender: events.some((e) => e.rts),
    };
  }

  /**
   * India Post returns scans newest-first; we sort oldest-first so `events[0]`
   * is the booking and the last entry is the latest state.
   */
  private mapEvents(raw: IndiaPostTrackingEvent[]): TrackingEvent[] {
    return raw
      .map((e) => ({
        timestamp: e.date,
        event: e.event,
        eventType: this.eventType(e.event),
        office: e.office || '',
        pincode: String(e.officeid ?? ''),
        remarks: e.remarks || '',
        rts: Boolean(e.rts),
      }))
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
  }

  /** "Item Kept on Hold" → "ItemKeptOnHold", for callers matching on a code. */
  private eventType(event: string): string {
    return (event || '')
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');
  }

  private str(value: string | number | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value);
  }
}
