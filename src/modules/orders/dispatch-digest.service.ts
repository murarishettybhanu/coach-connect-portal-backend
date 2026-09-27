import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderStatus } from '../../schemas/order.schema';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { titleCaseName } from '../../common/utils/name.util';

/** Meta template `order_dispach_update_for_tribe_owner`. */
const DEFAULT_TEMPLATE_ID = '1393420296257983';
const TIMEZONE = 'Asia/Kolkata';
/** The cut-off: each digest covers the 24h ending at 9pm IST. */
const CUTOFF_HOUR = 21;

export interface DispatchLine {
  product: string;
  shipments: number;
}

/** The slice of a populated order this job reads. */
interface PopulatedOrder {
  coachId?: {
    _id?: Types.ObjectId | string;
    name?: string;
    brand?: string;
    username?: string;
    userId?: { name?: string; phoneNumber?: string | number } | null;
  } | null;
  items?: Array<{
    selected?: boolean;
    productId?: { name?: string } | null;
  }>;
}

export interface TribeDigest {
  tribeId: string;
  tribeName: string;
  brand: string;
  ownerName: string;
  phone?: string;
  totalShipments: number;
  lines: DispatchLine[];
}

/**
 * Nightly dispatch summary to each tribe owner on WhatsApp.
 *
 * Runs at 9pm IST and reports the window since the previous 9pm, so the
 * boundary matches what the message claims ("today's dispatch summary") rather
 * than a UTC day, which would cut the evening off mid-shift.
 *
 * Sending is **off unless explicitly configured**, so deploying this can't
 * blast real customers by accident:
 *  - `WHATSAPP_DIGEST_TEST_NUMBER` — every digest goes to this one number
 *    instead of the owners, carrying the real tribe's figures. Rollout step 1.
 *  - `WHATSAPP_DIGEST_ENABLED=true` — send to the actual tribe owners.
 *  - neither set — compute and log only, sending nothing.
 *
 * Tribes with nothing dispatched in the window are skipped: most nights only
 * one to three tribes ship anything, and a nightly "0 shipments" to everyone
 * else is how a business number gets muted or reported.
 */
@Injectable()
export class DispatchDigestService {
  private readonly logger = new Logger(DispatchDigestService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Cron('0 21 * * *', { name: 'dispatch-digest', timeZone: TIMEZONE })
  async runNightly(): Promise<void> {
    const { start, end } = this.windowEndingAt(new Date());
    await this.run(start, end);
  }

  /**
   * Builds and sends the digests for one window. Exposed so it can be run for
   * a chosen window without waiting for 9pm.
   */
  async run(start: Date, end: Date): Promise<TribeDigest[]> {
    const digests = await this.buildDigests(start, end);
    const testNumber = process.env.WHATSAPP_DIGEST_TEST_NUMBER?.trim();
    const enabled = process.env.WHATSAPP_DIGEST_ENABLED === 'true';
    const templateId =
      process.env.WHATSAPP_DIGEST_TEMPLATE_ID?.trim() || DEFAULT_TEMPLATE_ID;

    this.logger.log(
      `Dispatch digest ${start.toISOString()} → ${end.toISOString()}: ` +
        `${digests.length} tribe(s) with dispatches` +
        (testNumber
          ? ` — routing all to test number ${this.mask(testNumber)}`
          : enabled
            ? ' — sending to tribe owners'
            : ' — dry run, nothing will be sent'),
    );

    for (const digest of digests) {
      const summary = this.summaryText(digest.lines);
      this.logger.log(
        `  ${digest.brand}: ${digest.totalShipments} shipment(s) — ${summary}`,
      );

      const to = testNumber || digest.phone;
      if (!testNumber && !enabled) continue;
      if (!to) {
        this.logger.warn(
          `  skipped ${digest.brand}: the owner has no phone number on record`,
        );
        continue;
      }

      try {
        await this.whatsapp.sendTemplateByIdTo(to, templateId, {
          date: this.formatDate(end),
          client_name: titleCaseName(digest.ownerName) || digest.brand,
          client_brand: digest.brand,
          dispatch_summary: summary,
          total_shipments: String(digest.totalShipments),
        });
      } catch (err) {
        // One tribe's failure must not stop the rest of the run.
        this.logger.error(
          `  failed to send the digest for ${digest.brand}: ${(err as Error).message}`,
        );
      }
    }

    return digests;
  }

  /**
   * Counts orders that entered DISPATCHED inside the window, grouped by tribe
   * and product. `statusHistory` is the only record of *when* a dispatch
   * happened — the order's own timestamps move on to delivery.
   *
   * A shipment is an order, not a unit: an order of three tees is one
   * shipment. An order holding two different products counts once against
   * each, so the product lines can legitimately sum to more than the total.
   */
  private async buildDigests(start: Date, end: Date): Promise<TribeDigest[]> {
    const orders = (await this.orderModel
      .find({
        isDeleted: { $ne: true },
        statusHistory: {
          $elemMatch: {
            status: OrderStatus.DISPATCHED,
            at: { $gte: start, $lt: end },
          },
        },
      })
      .populate('items.productId', 'name')
      .populate({
        path: 'coachId',
        select: 'name brand username userId',
        populate: { path: 'userId', select: 'name phoneNumber' },
      })
      .lean()
      .exec()) as unknown as PopulatedOrder[];

    const byTribe = new Map<
      string,
      TribeDigest & { counts: Map<string, number> }
    >();

    for (const order of orders) {
      const tribe = order.coachId;
      if (!tribe?._id) continue;
      const tribeId = String(tribe._id);

      let entry = byTribe.get(tribeId);
      if (!entry) {
        const owner = tribe.userId || {};
        entry = {
          tribeId,
          tribeName: tribe.name || tribe.username || 'Tribe',
          brand: tribe.brand || tribe.name || 'your store',
          ownerName: owner.name || tribe.name || '',
          phone: owner.phoneNumber ? String(owner.phoneNumber) : undefined,
          totalShipments: 0,
          lines: [],
          counts: new Map<string, number>(),
        };
        byTribe.set(tribeId, entry);
      }

      entry.totalShipments += 1;

      // Unselected items were dropped during approval and never shipped.
      const products = new Set<string>();
      for (const item of order.items || []) {
        if (item.selected === false) continue;
        const name = item.productId?.name;
        if (name) products.add(name);
      }
      for (const name of products) {
        entry.counts.set(name, (entry.counts.get(name) || 0) + 1);
      }
    }

    return [...byTribe.values()]
      .map(({ counts, ...digest }) => ({
        ...digest,
        lines: [...counts.entries()]
          .map(([product, shipments]) => ({ product, shipments }))
          .sort(
            (a, b) =>
              b.shipments - a.shipments || a.product.localeCompare(b.product),
          ),
      }))
      .sort((a, b) => b.totalShipments - a.totalShipments);
  }

  /**
   * The 24 hours ending at the most recent 9pm IST. Run at 9pm this is
   * "yesterday 9pm → now"; run at any other time it still lines up with a
   * real cut-off rather than a partial day.
   */
  windowEndingAt(now: Date): { start: Date; end: Date } {
    // IST is UTC+05:30 and India observes no DST, so the offset is a constant.
    // The half hour matters: doing this with the server's own clock (UTC) and
    // zeroing the minutes lands on 20:30 or 21:30 IST, never 21:00.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Shift into IST so the UTC getters read as IST wall-clock fields.
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    const todayCutoff = Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate(),
      CUTOFF_HOUR,
    );
    // The most recent 9pm IST: today's once we're past it, otherwise yesterday's.
    const endWall =
      ist.getUTCHours() >= CUTOFF_HOUR ? todayCutoff : todayCutoff - DAY_MS;

    const end = new Date(endWall - IST_OFFSET_MS);
    return { start: new Date(end.getTime() - DAY_MS), end };
  }

  /**
   * Meta rejects a parameter containing newlines, so the product lines are
   * joined inline — which is why the template's own example shows them run
   * together rather than stacked.
   */
  summaryText(lines: DispatchLine[]): string {
    if (!lines.length) return 'No product breakdown available';
    return lines
      .map(
        (l) =>
          `📦 ${l.product} — ${l.shipments} shipment${l.shipments === 1 ? '' : 's'}`,
      )
      .join('  ');
  }

  private formatDate(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: TIMEZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  private mask(phone: string): string {
    return phone.replace(/\d(?=\d{4})/g, 'x');
  }
}
