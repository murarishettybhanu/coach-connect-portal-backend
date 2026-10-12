import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { timingSafeEqual } from 'crypto';
import { ApprovalStatus, Order, OrderStatus } from '../../schemas/order.schema';
import { PostalEvent } from '../../schemas/postal-event.schema';
import { OrdersService } from '../orders/orders.service';
import {
  milestoneOf,
  parsePostalPayload,
  type ParsedPostalEvent,
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
        trackingNumber: {
          $in: [e.articleNumber, e.articleNumber.toLowerCase()],
        },
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
    await this.orderModel
      .updateOne(
        {
          _id: order._id,
          $or: [
            { lastPostalEvent: { $exists: false } },
            { 'lastPostalEvent.at': { $lte: e.eventAt } },
          ],
        } as any,
        {
          $set: {
            lastPostalEvent: {
              code: e.eventCode,
              description: e.description || e.eventCode,
              at: e.eventAt,
              office: e.office,
            },
          },
        },
      )
      .exec();

    try {
      await this.apply(order, e);
    } catch (err) {
      // The scan is stored; only the order update failed (e.g. it changed meanwhile).
      this.logger.error(
        `India Post ${e.articleNumber}: couldn't update order ${String(order._id)}: ${(err as Error).message}`,
      );
    }
    return true;
  }

  /** What a milestone event does to its order. */
  private async apply(order: any, e: ParsedPostalEvent): Promise<void> {
    const id = String(order._id);
    const milestone = milestoneOf(e.eventCode, e.description);
    const awaitingApproval = order.approvalStatus === ApprovalStatus.PENDING;
    if (milestone === 'BOOKED') {
      if (
        !awaitingApproval &&
        [OrderStatus.NEW, OrderStatus.PACKED].includes(order.status)
      ) {
        await this.orders.updateStatus(id, OrderStatus.DISPATCHED);
        this.logger.log(
          `Order ${id} dispatched from India Post booking of ${e.articleNumber}`,
        );
      }
    } else if (milestone === 'DELIVERED') {
      if (
        !awaitingApproval &&
        [OrderStatus.NEW, OrderStatus.PACKED, OrderStatus.DISPATCHED].includes(
          order.status,
        )
      ) {
        await this.orders.updateStatus(
          id,
          OrderStatus.DELIVERED,
          undefined,
          undefined,
          {
            skipDispatch: true,
          },
        );
        this.logger.log(
          `Order ${id} delivered per India Post (${e.articleNumber})`,
        );
      }
    } else if (milestone === 'RETURNED') {
      if (!order.postalReturnReportedAt) {
        await this.orderModel
          .updateOne({ _id: order._id } as any, {
            $set: { postalReturnReportedAt: e.eventAt },
          })
          .exec();
        this.logger.warn(
          `India Post reports ${e.articleNumber} returned (order ${id})`,
        );
      }
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
