import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApprovalStatus, Order, OrderStatus } from '../../schemas/order.schema';
import {
  andCampaignFilter,
  coachIdsFilter,
} from '../../common/utils/coach-ids.util';
import {
  TrackingService,
  type TrackingResult,
} from '../tracking/tracking.service';
import { PostalWebhookService } from './postal-webhook.service';
import {
  isMovementScan,
  milestoneOf,
  type PostalMilestone,
} from './postal-event-rules';

const ARTICLE_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const BATCH = 500; // India Post's bulk tracking limit per call
const MAX_ORDERS = 3000;

export type SyncChange = {
  orderId: string;
  customer: string;
  trackingNumber: string;
  from: string;
  change: 'DISPATCHED' | 'DELIVERED' | 'RETURN_FLAGGED';
  scan: string;
};

export type SyncSummary = {
  /** Preview: what would change — nothing was written or sent. */
  dryRun: boolean;
  checked: number;
  notFound: number;
  dispatched: number;
  delivered: number;
  returnsFlagged: number;
  unchanged: number;
  failed: number;
  /** Skipped: the tracking number is on more than one order. */
  sharedNumber: number;
  changes: SyncChange[];
  errors: string[];
};

/**
 * "Sync with India Post": reads current tracking for every Ready to Ship and
 * Dispatched order (optionally one tribe / campaign) and applies the same
 * milestones the webhook does (PostalWebhookService.applyMilestone):
 *   returned to sender → flag (precedence: a "delivered" after a return is
 *                        delivery back to us, not to the customer)
 *   delivered          → Delivered
 *   known to India Post (booked / scanned) while Ready to Ship → Dispatched
 * Every order checked also gets its latest scan (`lastPostalEvent`); the scan
 * history itself isn't stored — it's fetched live when someone asks.
 */
@Injectable()
export class PostalSyncService {
  private readonly logger = new Logger(PostalSyncService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly tracking: TrackingService,
    private readonly webhook: PostalWebhookService,
  ) {}

  /** The milestone a tracking result means for an order (null = nothing to do). */
  static milestoneFor(r: TrackingResult): PostalMilestone {
    if (!r.found) return null;
    const returned =
      r.returnToSender ||
      r.events.some((e) => milestoneOf('', e.event) === 'RETURNED');
    if (returned) return 'RETURNED';
    if (r.delivered) return 'DELIVERED';
    // Only a real booking / movement scan means India Post has the parcel — a
    // pickup request or pre-advice record must not mark it Dispatched.
    return r.events.some((e) => isMovementScan('', e.event)) ? 'BOOKED' : null;
  }

  async sync(
    opts: { coachId?: string; campaignId?: string; dryRun?: boolean } = {},
  ): Promise<SyncSummary> {
    const dryRun = !!opts.dryRun;
    const filter: any = {
      status: { $in: [OrderStatus.PACKED, OrderStatus.DISPATCHED] },
      isDeleted: { $ne: true },
      approvalStatus: {
        $nin: [ApprovalStatus.PENDING, ApprovalStatus.REJECTED],
      },
      trackingNumber: { $exists: true, $nin: [null, ''] },
    };
    const coaches = coachIdsFilter(opts.coachId);
    if (coaches) filter.coachId = coaches;
    andCampaignFilter(filter, opts.campaignId);

    const orders: any[] = await this.orderModel
      .find(filter)
      .select(
        '_id status approvalStatus trackingNumber postalReturnReportedAt shippingAddress.fullName',
      )
      .limit(MAX_ORDERS)
      .lean()
      .exec();

    const summary: SyncSummary = {
      dryRun,
      checked: 0,
      notFound: 0,
      dispatched: 0,
      delivered: 0,
      returnsFlagged: 0,
      unchanged: 0,
      failed: 0,
      sharedNumber: 0,
      changes: [],
      errors: [],
    };
    const numberOf = (o: any) =>
      String(o.trackingNumber ?? '')
        .trim()
        .toUpperCase();
    const valid = orders.filter((o) => ARTICLE_RE.test(numberOf(o)));
    summary.failed += orders.length - valid.length; // unreadable tracking numbers
    const numbers = [...new Set(valid.map(numberOf))];

    // A number on several (non-deleted) orders — any status — is a data
    // problem: touch none of them, as the webhook and Mark Delivered refuse too.
    const shared = new Set<string>(
      numbers.length
        ? (
            await this.orderModel
              .aggregate<{
                _id: string;
              }>([
                {
                  $match: {
                    isDeleted: { $ne: true },
                    trackingNumber: { $type: 'string' },
                  },
                },
                {
                  $project: {
                    key: { $toUpper: { $trim: { input: '$trackingNumber' } } },
                  },
                },
                { $match: { key: { $in: numbers } } },
                { $group: { _id: '$key', n: { $sum: 1 } } },
                { $match: { n: { $gt: 1 } } },
              ])
              .exec()
          ).map((g) => g._id)
        : [],
    );

    const results = new Map<string, TrackingResult>();
    for (let i = 0; i < numbers.length; i += BATCH) {
      const chunk = numbers.slice(i, i + BATCH);
      try {
        for (const r of await this.tracking.trackMany(chunk))
          results.set(r.consignmentNumber, r);
      } catch (err) {
        summary.errors.push((err as Error).message);
        this.logger.error(
          `India Post sync: a batch of ${chunk.length} failed: ${(err as Error).message}`,
        );
      }
    }

    for (const order of valid) {
      const number = numberOf(order);
      if (shared.has(number)) {
        summary.sharedNumber++;
        continue;
      }
      const r = results.get(number);
      if (!r || !r.available) {
        // Couldn't be checked (the API failed for it) — not "unknown to India Post".
        summary.failed++;
        if (r?.message && !summary.errors.includes(r.message))
          summary.errors.push(r.message);
        continue;
      }
      summary.checked++;
      if (!r.found) {
        summary.notFound++;
        continue;
      }
      try {
        const last = r.events[r.events.length - 1];
        if (
          !dryRun &&
          last &&
          !Number.isNaN(new Date(last.timestamp).getTime())
        ) {
          await this.webhook.recordLatestScan(order._id, {
            code: last.eventType,
            description: last.event,
            at: new Date(last.timestamp),
            office: last.office,
          });
        }

        const milestone = PostalSyncService.milestoneFor(r);
        const at = new Date(r.deliveredAt || r.lastUpdatedAt || Date.now());
        const change = await this.webhook.applyMilestone(
          order,
          milestone,
          at,
          number,
          {
            dryRun,
          },
        );
        if (!change) {
          summary.unchanged++;
          continue;
        }
        if (change === 'DISPATCHED') summary.dispatched++;
        if (change === 'DELIVERED') summary.delivered++;
        if (change === 'RETURN_FLAGGED') summary.returnsFlagged++;
        if (summary.changes.length < 300) {
          summary.changes.push({
            orderId: String(order._id),
            customer: order.shippingAddress?.fullName ?? '',
            trackingNumber: number,
            from: order.status,
            change,
            scan: r.currentStatus,
          });
        }
      } catch (err) {
        summary.failed++;
        this.logger.error(
          `India Post sync: order ${String(order._id)} (${number}): ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `India Post sync${dryRun ? ' (preview)' : ''}: ${summary.checked} checked, ${summary.dispatched} dispatched, ${summary.delivered} delivered, ${summary.returnsFlagged} returns flagged, ${summary.notFound} not found, ${summary.failed} failed`,
    );
    return summary;
  }
}
