import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order } from '../../schemas/order.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { milestoneOf } from '../postal-webhook/postal-event-rules';
import { UserRole } from '../../schemas/user.schema';
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

/** The caller, as JwtStrategy puts it on the request. */
export interface TrackingCaller {
  _id: unknown;
  role: UserRole | string;
}

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

  constructor(
    private readonly indiaPost: IndiaPostApiService,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    @InjectModel(Tribe.name) private readonly tribeModel: Model<Tribe>,
  ) {}

  async track(consignmentNumber: string): Promise<TrackingResult> {
    const number = this.normalize(consignmentNumber);
    const [result] = await this.trackMany([number]);
    return result;
  }

  /**
   * `trackMany`, scoped to what the caller may see. Admins track anything; a
   * tribe only numbers on its own orders. Anything else answers exactly like
   * an article India Post doesn't know — never "forbidden" — so a tribe can't
   * probe which numbers belong to someone else, and nothing it isn't owed is
   * sent upstream at all.
   */
  async trackManyFor(
    caller: TrackingCaller,
    consignmentNumbers: string[],
  ): Promise<TrackingResult[]> {
    const numbers = consignmentNumbers.map((n) => this.normalize(n));
    if (caller.role === UserRole.ADMIN) return this.trackMany(numbers);

    const owned =
      caller.role === UserRole.TRIBE
        ? await this.ownedNumbers(caller._id, numbers)
        : new Set<string>();
    const allowed = numbers.filter((n) => owned.has(n));
    const results = allowed.length ? await this.trackMany(allowed) : [];
    const byNumber = new Map(results.map((r) => [r.consignmentNumber, r]));

    return numbers.map((n) => byNumber.get(n) ?? this.map(n, undefined));
  }

  async trackFor(
    caller: TrackingCaller,
    consignmentNumber: string,
  ): Promise<TrackingResult> {
    const [result] = await this.trackManyFor(caller, [consignmentNumber]);
    return result;
  }

  /** Which of `numbers` are tracking numbers on the caller's tribe's orders. */
  private async ownedNumbers(
    userId: unknown,
    numbers: string[],
  ): Promise<Set<string>> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id')
      .lean()
      .exec();
    if (!tribe) return new Set();

    // Tracking numbers are typed in by hand at dispatch as well as assigned
    // from the barcode pool, so match without regard to case. The numbers are
    // already validated as [A-Z0-9], so they are safe inside a pattern.
    const orders = await this.orderModel
      .find({
        coachId: tribe._id,
        trackingNumber: {
          $in: [...new Set(numbers)].map(
            (n) => new RegExp(`^\\s*${n}\\s*$`, 'i'),
          ),
        },
      } as any)
      .select('trackingNumber')
      .lean()
      .exec();

    return new Set(
      orders.map((o) =>
        String(o.trackingNumber ?? '')
          .trim()
          .toUpperCase(),
      ),
    );
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

    // "not delivered" / "Item not Delivered" contain the word, so a plain
    // /deliver/ test reads them backwards — use the shared milestone rules.
    const delStatus = (article?.del_status?.del_status || '').trim();
    const deliveredByStatus = milestoneOf('', delStatus) === 'DELIVERED';
    const deliveredEvent = [...events]
      .reverse()
      .find((e) => milestoneOf('', e.event) === 'DELIVERED');
    // A returned parcel's "delivered" is delivery back to us, never to the customer.
    const returnToSender = events.some(
      (e) => e.rts || milestoneOf('', e.event) === 'RETURNED',
    );
    const delivered =
      !returnToSender &&
      Boolean(
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
      deliveredAt: delivered
        ? booking?.delivery_confirmed_on || deliveredEvent?.timestamp || null
        : null,
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
      returnToSender,
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
    // India Post's clock is IST even where the value says "Z" (their own
    // booked_on carries +05:30 for the same instant). Rebuild the instant from
    // the calendar date + the separate `time` (or the date's own clock) as IST.
    const date = (e.date || '').trim();
    const time = (e.time || '').trim();
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(date)?.[1];
    if (!day) return date;
    const clock =
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time) ||
      /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(date);
    const hms = clock
      ? `${clock[1].padStart(2, '0')}:${clock[2]}:${clock[3] ?? '00'}`
      : '00:00:00';
    const at = new Date(`${day}T${hms}+05:30`);
    return Number.isNaN(at.getTime()) ? date : at.toISOString();
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
