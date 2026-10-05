// Dispatch counts behind the restock overview's pace, shared with the
// analytics dashboard so both show the same stock levels. Plain functions
// over models handed in by the caller — no Nest providers, so sharing them
// can't create a DI cycle between feature modules.
import { Model } from 'mongoose';
import { Order, OrderStatus } from '../../schemas/order.schema';
import { Campaign } from '../../schemas/campaign.schema';
import { PACE_DAYS, WINDOW_DAYS } from './restock-math';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Units dispatched per product / kit claims per kit, in one window. */
export interface WindowCounts {
  byProduct: Map<string, number>;
  byKit: Map<string, number>;
  units: number;
  orders: number;
}

export const emptyCounts = (): WindowCounts => ({
  byProduct: new Map(),
  byKit: new Map(),
  units: 0,
  orders: 0,
});

const bump = (m: Map<string, number>, key: string, n: number) =>
  m.set(key, (m.get(key) ?? 0) + n);

/** The tribe's kit-linked campaigns (`_id`, `kitId`), looked up once. */
export function findKitCampaigns(
  campaignModel: Model<Campaign>,
  coachId: string,
) {
  return campaignModel
    .find({ coachId, kitId: { $ne: null } } as any)
    .select('kitId')
    .lean()
    .exec();
}

/** campaign id → kit id. */
export function kitOfCampaignMap(campaigns: any[]) {
  return new Map<string, string>(
    campaigns.map((c: any) => [String(c._id), String(c.kitId)]),
  );
}

/**
 * Every order of the tribe dispatched in the last 28 days, in ONE query
 * (`statusHistory` holds the only record of when a dispatch happened).
 */
export function findDispatchedInPace(
  orderModel: Model<Order>,
  coachId: string,
  now: Date,
) {
  const paceStart = new Date(now.getTime() - PACE_DAYS * DAY_MS);
  return orderModel
    .find({
      coachId,
      isDeleted: { $ne: true },
      statusHistory: {
        $elemMatch: {
          status: OrderStatus.DISPATCHED,
          at: { $gte: paceStart, $lte: now },
        },
      },
    } as any)
    .select(
      'campaignId statusHistory.status statusHistory.at items.productId items.quantity items.selected',
    )
    .lean()
    .exec();
}

/**
 * Splits the 28-day dispatches into the 7-day ("this week") and 28-day
 * (pace) counts.
 *
 * - product: Σ quantity of the order's lines for that product. Lines
 *   unticked at approval (`selected: false`) were never sent, so they don't
 *   count.
 * - kit: one per order whose campaign is linked to the kit.
 */
export function splitDispatchCounts(
  orders: any[],
  kitOfCampaign: Map<string, string>,
  now: Date,
) {
  const weekStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const paceStart = new Date(now.getTime() - PACE_DAYS * DAY_MS);
  const week = emptyCounts();
  const pace = emptyCounts();

  for (const order of orders) {
    const dispatches = (order.statusHistory || []).filter(
      (h: any) =>
        h.status === OrderStatus.DISPATCHED &&
        h.at &&
        new Date(h.at) >= paceStart &&
        new Date(h.at) <= now,
    );
    if (!dispatches.length) continue;
    const inWeek = dispatches.some((h: any) => new Date(h.at) >= weekStart);
    const targets = inWeek ? [week, pace] : [pace];

    const kitId = order.campaignId
      ? kitOfCampaign.get(String(order.campaignId))
      : undefined;
    for (const t of targets) {
      t.orders += 1;
      if (kitId) bump(t.byKit, kitId, 1);
      for (const line of order.items || []) {
        if (line.selected === false || !line.productId) continue;
        const qty = Number(line.quantity) || 0;
        t.units += qty;
        bump(t.byProduct, String(line.productId), qty);
      }
    }
  }
  return { week, pace };
}
