import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { timingSafeEqual } from 'crypto';
import { ApprovalStatus, Order, OrderStatus } from '../../schemas/order.schema';
import { PostalEvent } from '../../schemas/postal-event.schema';
import { PostalWebhookLog } from '../../schemas/postal-webhook-log.schema';
import { OrdersService } from '../orders/orders.service';
import {
  isMovementScan,
  milestoneOf,
  parsePostalPayload,
  type ParsedPostalEvent,
  type PostalMilestone,
} from './postal-event-rules';

/**
 * India Post's webhook (Customer Integrations §13.8): they push each scan of
 * our articles to us. Every event is stored (PostalEvent); for the one order
 * carrying the article it then:
 *   - keeps `order.lastPostalEvent` current,
 *   - Item Booked    → New / Ready to Ship becomes Dispatched,
 *   - Item Delivered → New / Ready to Ship / Dispatched becomes Delivered,
 *   - Item Returned  → flags `postalReturnReportedAt` (logging the return stays manual).
 * Status changes go through OrdersService.updateStatus, so history, barcode and
 * the customer's WhatsApp updates are the same as a manual move.
 *
 * Never throws for a bad event: India Post retries failed deliveries, and one
 * odd scan must not block the rest. Repeats of a scan are stored once and do
 * nothing the second time.
 */
@Injectable()
export class PostalWebhookService {
  private readonly logger = new Logger(PostalWebhookService.name);

  constructor(
    @InjectModel(PostalEvent.name)
    private readonly eventModel: Model<PostalEvent>,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly orders: OrdersService,
    @InjectModel(PostalWebhookLog.name)
    private readonly logModel?: Model<PostalWebhookLog>,
  ) {}

  /** The secret path segment India Post must use; unset = webhook disabled. */
  tokenMatches(token: string): boolean {
    const expected = process.env.INDIAPOST_WEBHOOK_TOKEN?.trim();
    if (!expected || expected.length < 16) return false;
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async ingest(body: unknown, channel: 'BOOKING' | 'OTHER') {
    const events = parsePostalPayload(body);
    let stored = 0;
    for (const e of events) {
      try {
        if (await this.handle(e, channel)) stored++;
      } catch (err) {
        this.logger.error(
          `India Post event ${e.articleNumber} ${e.eventCode || e.description} failed: ${(err as Error).message}`,
        );
      }
    }
    if (events.length) {
      this.logger.log(
        `India Post webhook (${channel}): ${events.length} received, ${stored} new`,
      );
    }
    return { received: events.length, stored };
  }

  /** Stores one event and applies it. Returns false for a repeat. */
  private async handle(
    e: ParsedPostalEvent,
    channel: 'BOOKING' | 'OTHER',
  ): Promise<boolean> {
    const matches: any[] = await this.orderModel
      .find({
        isDeleted: { $ne: true },
        // Hand-typed numbers are stored as typed (any case, maybe padded).
        trackingNumber: new RegExp(`^\\s*${e.articleNumber}\\s*$`, 'i'),
      } as any)
      .select(
        '_id status approvalStatus lastPostalEvent postalReturnReportedAt',
      )
      .lean()
      .exec();
    // Several orders on one number is a data problem; record, but touch none.
    const order = matches.length === 1 ? matches[0] : null;

    // The unique index is the real guard; this also covers the moment before
    // it exists (a fresh collection) and saves a write for the common repeat.
    const seen = await this.eventModel
      .exists({
        articleNumber: e.articleNumber,
        eventCode: e.eventCode,
        eventAt: e.eventAt,
        officeId: e.officeId,
      } as any)
      .exec();
    if (seen) return false;
    try {
      await this.eventModel.create({ ...e, channel, orderId: order?._id });
    } catch (err: any) {
      if (err?.code === 11000) return false; // already have this scan
      throw err;
    }
    if (!order) return true;

    // Latest scan on the order — only ever forward, since events can arrive out of order.
    await this.recordLatestScan(order._id, {
      code: e.eventCode,
      description: e.description || e.eventCode,
      at: e.eventAt,
      office: e.office,
    });

    try {
      await this.apply(order, e);
    } catch (err) {
      // The order changed under us (a concurrent scan or sync): re-read it and
      // try once more — a retry from India Post would be deduped and lost.
      if (err instanceof ConflictException) {
        try {
          const fresh = await this.orderModel
            .findById(order._id)
            .select('_id status approvalStatus postalReturnReportedAt')
            .lean()
            .exec();
          if (fresh) {
            await this.apply(fresh, e);
            return true;
          }
        } catch (retryErr) {
          err = retryErr;
        }
      }
      // The scan is stored; only the order update failed.
      this.logger.error(
        `India Post ${e.articleNumber}: couldn't update order ${String(order._id)}: ${(err as Error).message}`,
      );
    }
    return true;
  }

  /** What a milestone event does to its order. */
  private async apply(order: any, e: ParsedPostalEvent): Promise<void> {
    // Any real movement scan (bagged, received …) means it was booked, even
    // if the Item Booked event itself never reached us.
    let milestone =
      milestoneOf(e.eventCode, e.description, e.nonDeliveryReason) ??
      (isMovementScan(e.eventCode, e.description) ? 'BOOKED' : null);
    // A "delivered" after the parcel was returned is delivery back to us.
    if (
      milestone === 'DELIVERED' &&
      (await this.wasReturned(e.articleNumber))
    ) {
      milestone = 'RETURNED';
    }
    await this.applyMilestone(order, milestone, e.eventAt, e.articleNumber);
  }

  /** Whether any stored scan of this article is a return. */
  private async wasReturned(articleNumber: string): Promise<boolean> {
    const rows: any[] = await this.eventModel
      .find({ articleNumber } as any)
      .select('eventCode description')
      .lean()
      .exec();
    return rows.some(
      (r) => milestoneOf(r.eventCode, r.description) === 'RETURNED',
    );
  }

  /**
   * The one place an India Post milestone moves an order — shared by the
   * webhook and the "Sync with India Post" button, so both behave the same:
   *   BOOKED    → New / Ready to Ship become Dispatched
   *   DELIVERED → New / Ready to Ship / Dispatched become Delivered (skipDispatch)
   *   RETURNED  → flag `postalReturnReportedAt` only (logging the return is manual)
   * Orders awaiting approval are never moved. Returns what changed (or null).
   */
  async applyMilestone(
    order: {
      _id: unknown;
      status: string;
      approvalStatus?: string | null;
      postalReturnReportedAt?: Date | null;
    },
    milestone: PostalMilestone,
    at: Date,
    articleNumber: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<'DISPATCHED' | 'DELIVERED' | 'RETURN_FLAGGED' | null> {
    const id = String(order._id);
    const awaitingApproval = order.approvalStatus === ApprovalStatus.PENDING;
    if (milestone === 'BOOKED') {
      if (
        !awaitingApproval &&
        [OrderStatus.NEW, OrderStatus.PACKED].includes(
          order.status as OrderStatus,
        )
      ) {
        if (opts.dryRun) return 'DISPATCHED';
        await this.orders.updateStatus(id, OrderStatus.DISPATCHED);
        this.logger.log(
          `Order ${id} dispatched from India Post booking of ${articleNumber}`,
        );
        return 'DISPATCHED';
      }
    } else if (milestone === 'DELIVERED') {
      // Return wins: once India Post reported it returned, a later "delivered"
      // is the parcel reaching us, not the customer.
      if (order.postalReturnReportedAt) return null;
      if (
        !awaitingApproval &&
        [OrderStatus.NEW, OrderStatus.PACKED, OrderStatus.DISPATCHED].includes(
          order.status as OrderStatus,
        )
      ) {
        if (opts.dryRun) return 'DELIVERED';
        await this.orders.updateStatus(
          id,
          OrderStatus.DELIVERED,
          undefined,
          undefined,
          { skipDispatch: true, note: 'Delivered per India Post' },
        );
        this.logger.log(
          `Order ${id} delivered per India Post (${articleNumber})`,
        );
        return 'DELIVERED';
      }
    } else if (milestone === 'RETURNED') {
      if (!order.postalReturnReportedAt) {
        if (opts.dryRun) return 'RETURN_FLAGGED';
        await this.orderModel
          .updateOne({ _id: order._id } as any, {
            $set: { postalReturnReportedAt: at },
          })
          .exec();
        this.logger.warn(
          `India Post reports ${articleNumber} returned (order ${id})`,
        );
        return 'RETURN_FLAGGED';
      }
    }
    return null;
  }

  /** Keeps `order.lastPostalEvent` on the newest scan (events arrive out of order). */
  async recordLatestScan(
    orderId: unknown,
    scan: { code: string; description: string; at: Date; office: string },
  ): Promise<void> {
    await this.orderModel
      .updateOne(
        {
          _id: orderId,
          $or: [
            { lastPostalEvent: { $exists: false } },
            { 'lastPostalEvent.at': { $lte: scan.at } },
          ],
        } as any,
        { $set: { lastPostalEvent: scan } },
      )
      .exec();
  }

  /**
   * Stores a scan learned some other way (the tracking API) in `postalevents`,
   * so Track Order's history and the webhook share one record. Repeats skip.
   */
  async storeScan(
    e: Omit<ParsedPostalEvent, 'raw'> & { raw?: Record<string, unknown> },
    orderId?: unknown,
  ) {
    const seen = await this.eventModel
      .exists({
        articleNumber: e.articleNumber,
        eventCode: e.eventCode,
        eventAt: e.eventAt,
        officeId: e.officeId,
      } as any)
      .exec();
    if (seen) return false;
    try {
      await this.eventModel.create({
        ...e,
        raw: e.raw ?? {},
        channel: 'SYNC',
        orderId: orderId as any,
      });
      return true;
    } catch (err: any) {
      if (err?.code === 11000) return false;
      throw err;
    }
  }

  /**
   * One row per webhook delivery (kept 30 days): what arrived and what we made
   * of it, including bodies we couldn't read — so a format surprise from India
   * Post is visible instead of silently dropped.
   */
  async logDelivery(entry: {
    channel: 'BOOKING' | 'OTHER';
    contentType: string;
    bytes: number;
    raw: string;
    received: number;
    stored: number;
    error?: string;
  }): Promise<void> {
    try {
      await this.logModel?.create({
        ...entry,
        raw: entry.raw.slice(0, 20_000),
      });
    } catch (err) {
      this.logger.error(
        `Could not log an India Post webhook delivery: ${(err as Error).message}`,
      );
    }
    if (!entry.received) {
      this.logger.warn(
        `India Post webhook (${entry.channel}): a delivery with no readable events (${entry.contentType || 'no content type'}, ${entry.bytes} bytes) — see postalwebhooklogs`,
      );
    }
  }

  /** Stored scans for these articles, oldest first, keyed by article number. */
  async eventsFor(
    articleNumbers: string[],
  ): Promise<Map<string, PostalEvent[]>> {
    const rows = await this.eventModel
      .find({ articleNumber: { $in: articleNumbers } } as any)
      .sort({ eventAt: 1 })
      .lean()
      .exec();
    const out = new Map<string, PostalEvent[]>();
    for (const r of rows as any[]) {
      const list = out.get(r.articleNumber) ?? [];
      list.push(r);
      out.set(r.articleNumber, list);
    }
    return out;
  }
}
