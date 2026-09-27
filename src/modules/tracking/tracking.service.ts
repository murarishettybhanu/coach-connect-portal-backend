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
 * An article India Post has no data for is not an error: the number is echoed
 * back with every other field blank, and maps to `found: false`. Their document
 * says only articles booked under our own customer id are reported; against UAT
 * that restriction did not appear to bite, so treat it as unconfirmed rather
 * than as a guarantee either way. See `IndiaPostApiService` for configuration.
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

    // Index the response by article number. Every number asked for comes back,
    // including ones India Post has no data for, so `map` decides what counts
    // as actually known.
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

    // An article India Post knows nothing about still comes back — with its
    // number echoed and every other field blank — so the presence of a
    // `booking_details` object proves nothing. Only real booking data counts.
    const hasBooking = Boolean(
      booking?.booked_on ||
      booking?.booked_at ||
      booking?.article_type ||
      booking?.delivery_location,
    );

    if (!hasBooking && !events.length) {
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

    const currentStatus = last?.event || 'Booked — awaiting first scan';

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
      // The API sends 0 for "not supplied", which would print as ₹0.
      tariff:
        typeof booking?.tariff === 'number' && booking.tariff > 0
          ? booking.tariff
          : undefined,
      returnToSender: events.some((e) => e.rts),
    };
  }

  /**
   * Scan order is not guaranteed — the integration document's samples are
   * newest-first and the live UAT API answers oldest-first — so we sort rather
   * than trust it: `events[0]` is the earliest and the last entry is current.
   */
  private mapEvents(raw: IndiaPostTrackingEvent[]): TrackingEvent[] {
    return raw
      .map((e) => ({
        timestamp: this.timestamp(e),
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

  /**
   * The live API zeroes the clock in `date` ("2026-02-19T00:00:00Z") and carries
   * the real time in `time` ("17:44:15"), so a scan's own date is not enough to
   * order same-day events or to show when anything happened. Stitch them back
   * together; entries that already carry a time (as the document's samples do)
   * are left alone.
   */
  private timestamp(e: IndiaPostTrackingEvent): string {
    const date = (e.date || '').trim();
    const time = (e.time || '').trim();
    if (!date || !time) return date;
    return /T00:00:00(\.0+)?(Z|[+-]\d{2}:?\d{2})?$/.test(date)
      ? date.replace(/T00:00:00(\.0+)?/, `T${time}`)
      : date;
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
