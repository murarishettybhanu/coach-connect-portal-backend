import {
  ForbiddenException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ApprovalStatus, Order, OrderStatus } from '../../schemas/order.schema';
import { Campaign } from '../../schemas/campaign.schema';
import { Product } from '../../schemas/product.schema';
import { TribeKit } from '../../schemas/tribe-kit.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { resolvePermissions } from '../../common/tribe-permissions';
import { buildableKits } from '../tribe-kits/tribe-kits.service';
import { RestockLevel, stockHealth } from '../restock/restock-math';
import {
  findDispatchedInPace,
  findKitCampaigns,
  kitOfCampaignMap,
  splitDispatchCounts,
} from '../restock/dispatch-counts';
import {
  Granularity,
  TIMEZONE,
  buckets,
  istDateKey,
  rate,
  resolveRange,
} from './analytics-range';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

/** The statusHistory events counted in range, and their response keys. */
const EVENTS = [
  { status: OrderStatus.DISPATCHED, key: 'dispatched' },
  { status: OrderStatus.DELIVERED, key: 'delivered' },
  { status: OrderStatus.RETURNED, key: 'returned' },
] as const;
type EventKey = (typeof EVENTS)[number]['key'];

const PENDING_STATUSES = [OrderStatus.NEW, OrderStatus.PACKED];

export interface AnalyticsItem {
  kind: 'PRODUCT' | 'KIT';
  id: string;
  name: string;
  dispatchedUnits: number;
  deliveredUnits: number;
  returnedUnits: number;
  returnRate: number;
  stock: number;
  consumedUnits: number;
  level: RestockLevel;
  daysLeft: number | null;
}

export interface TrendRow {
  bucket: string;
  label: string;
  orders: number;
  dispatched: number;
  delivered: number;
  returned: number;
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** 'a,b,,c' → unique ids; undefined when absent/empty; 400 on a bad id. */
export function parseIds(raw: string | undefined, field: string) {
  if (raw == null) return undefined;
  const ids = [
    ...new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return undefined;
  if (ids.some((id) => !OBJECT_ID_RE.test(id))) {
    throw new BadRequestException(`${field} must be comma-separated ids`);
  }
  return ids;
}

/** Items: kits first, then products; each by dispatchedUnits desc, then name. */
export function compareAnalyticsItems(a: AnalyticsItem, b: AnalyticsItem) {
  if (a.kind !== b.kind) return a.kind === 'KIT' ? -1 : 1;
  return b.dispatchedUnits - a.dispatchedUnits || a.name.localeCompare(b.name);
}

@Injectable()
export class AnalyticsService {
  constructor(
    // All read-only: the analytics module never writes anything.
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(TribeKit.name) private kitModel: Model<TribeKit>,
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
  ) {}

  /** The signed-in TRIBE user's own tribe id — never taken from the request. */
  /**
   * The caller's tribe — 404 if their account has none, 403 if an admin hasn't
   * switched on the Analytics permission for it (off by default).
   */
  async tribeIdForUser(userId: string): Promise<string> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id permissions')
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');
    if (!resolvePermissions((tribe as any).permissions).analytics) {
      throw new ForbiddenException(
        'Analytics is not enabled for your tribe. Contact the Tribe Merchandise team.',
      );
    }
    return String((tribe as any)._id);
  }

  /**
   * The dashboard. Round trips are fixed whatever the range or item count:
   * products, kits (+ their products' stock), kit-linked campaigns and the
   * 28-day pace dispatches in parallel, then ONE aggregation over the
   * range's orders.
   */
  async tribe(coachId: string, q: AnalyticsQueryDto, now = new Date()) {
    // Validate everything that needs no database first.
    const range = resolveRange(q, now);
    const productIds = parseIds(q.productIds, 'productIds');
    const kitIds = parseIds(q.kitIds, 'kitIds');

    const [products, kits, campaigns, paceOrders] = await Promise.all([
      this.productModel
        .find({ coachId, isDeleted: { $ne: true } } as any)
        .select('name stockLevel')
        .lean()
        .exec(),
      this.kitModel
        .find({ coachId, isDeleted: { $ne: true } } as any)
        .select('name items')
        .populate({ path: 'items.productId', select: 'stockLevel' })
        .lean()
        .exec(),
      findKitCampaigns(this.campaignModel, coachId),
      findDispatchedInPace(this.orderModel, coachId, now),
    ]);

    // Filters: the caller's own (non-deleted) items only.
    const ownProducts = new Set((products as any[]).map((p) => String(p._id)));
    const ownKits = new Set((kits as any[]).map((k) => String(k._id)));
    if (productIds?.some((id) => !ownProducts.has(id))) {
      throw new BadRequestException('productIds must be your own products');
    }
    if (kitIds?.some((id) => !ownKits.has(id))) {
      throw new BadRequestException('kitIds must be your own kits');
    }

    const kitOfCampaign = kitOfCampaignMap(campaigns as any[]);
    const filtered = !!(productIds || kitIds);
    const kitCampaignIds = kitIds
      ? [...kitOfCampaign]
          .filter(([, kit]) => kitIds.includes(kit))
          .map(([c]) => new Types.ObjectId(c))
      : [];
    const orderFilter = filtered
      ? {
          $or: [
            ...(productIds
              ? [
                  {
                    items: {
                      $elemMatch: {
                        productId: {
                          $in: productIds.map((id) => new Types.ObjectId(id)),
                        },
                        selected: { $ne: false },
                      },
                    },
                  },
                ]
              : []),
            ...(kitIds ? [{ campaignId: { $in: kitCampaignIds } }] : []),
          ],
        }
      : null;

    const agg = await this.aggregate(
      coachId,
      range.start,
      range.end,
      range.granularity,
      orderFilter,
    );

    // ── KPIs + trend ──────────────────────────────────────────────────────
    const trend: TrendRow[] = buckets(
      range.from,
      range.to,
      range.granularity,
    ).map((b) => ({
      ...b,
      orders: 0,
      dispatched: 0,
      delivered: 0,
      returned: 0,
    }));
    const byBucket = new Map(trend.map((t) => [t.bucket, t]));
    const kpis = {
      totalOrders: 0,
      dispatched: 0,
      delivered: 0,
      returned: 0,
      returnRate: 0,
      inTransit: 0,
      pending: 0,
      pendingApproval: 0,
    };
    for (const row of agg.created) {
      const n = Number(row.n) || 0;
      kpis.totalOrders += n;
      const t = byBucket.get(istDateKey(row._id));
      if (t) t.orders += n;
    }
    for (const row of agg.eventBuckets) {
      const key = row._id.k as EventKey;
      const n = Number(row.n) || 0;
      kpis[key] += n;
      const t = byBucket.get(istDateKey(row._id.b));
      if (t) t[key] += n;
    }
    kpis.returnRate = rate(kpis.returned, kpis.dispatched);
    const snap = agg.snapshot[0];
    if (snap) {
      kpis.inTransit = Number(snap.inTransit) || 0;
      kpis.pending = Number(snap.pending) || 0;
      kpis.pendingApproval = Number(snap.pendingApproval) || 0;
    }

    // ── Items ─────────────────────────────────────────────────────────────
    type Units = Record<EventKey, number>;
    const zero = (): Units => ({ dispatched: 0, delivered: 0, returned: 0 });
    const productUnits = new Map<string, Units>();
    const kitUnits = new Map<string, Units>();
    const unitsOf = (m: Map<string, Units>, id: string) => {
      let u = m.get(id);
      if (!u) m.set(id, (u = zero()));
      return u;
    };
    for (const row of agg.eventProducts) {
      unitsOf(productUnits, String(row._id.p))[row._id.k as EventKey] +=
        Number(row.units) || 0;
    }
    for (const row of agg.eventCampaigns) {
      const kit = kitOfCampaign.get(String(row._id.c));
      if (kit)
        unitsOf(kitUnits, kit)[row._id.k as EventKey] += Number(row.n) || 0;
    }

    // Levels are "now": the same pace window and maths as the restock overview.
    const { week, pace } = splitDispatchCounts(
      paceOrders as any[],
      kitOfCampaign,
      now,
    );
    const item = (
      kind: 'KIT' | 'PRODUCT',
      doc: any,
      stock: number,
      units: Units,
      shippedThisWeek: number,
      shipped28d: number,
    ): AnalyticsItem => {
      const health = stockHealth(stock, shippedThisWeek, shipped28d);
      return {
        kind,
        id: String(doc._id),
        name: doc.name ?? '',
        dispatchedUnits: units.dispatched,
        deliveredUnits: units.delivered,
        returnedUnits: units.returned,
        returnRate: rate(units.returned, units.dispatched),
        stock,
        consumedUnits: units.dispatched,
        level: health.level,
        daysLeft: health.daysLeft,
      };
    };

    const keepKit = (id: string) => !filtered || !!kitIds?.includes(id);
    const keepProduct = (id: string) => !filtered || !!productIds?.includes(id);
    const items = [
      ...(kits as any[])
        .filter((k) => keepKit(String(k._id)))
        .map((k) => {
          const id = String(k._id);
          return item(
            'KIT',
            k,
            buildableKits(k),
            kitUnits.get(id) ?? zero(),
            week.byKit.get(id) ?? 0,
            pace.byKit.get(id) ?? 0,
          );
        }),
      ...(products as any[])
        .filter((p) => keepProduct(String(p._id)))
        .map((p) => {
          const id = String(p._id);
          return item(
            'PRODUCT',
            p,
            Number(p.stockLevel) || 0,
            productUnits.get(id) ?? zero(),
            week.byProduct.get(id) ?? 0,
            pace.byProduct.get(id) ?? 0,
          );
        }),
    ].sort(compareAnalyticsItems);

    const stockAlerts = { OUT: 0, CRITICAL: 0, LOW: 0 };
    for (const i of items) {
      if (i.level !== 'HEALTHY') stockAlerts[i.level] += 1;
    }

    return {
      range: {
        from: range.from,
        to: range.to,
        granularity: range.granularity,
        timezone: TIMEZONE,
      },
      kpis,
      trend,
      items,
      stockAlerts,
    };
  }

  /**
   * One aggregation over the tribe's orders that matter for the range: created
   * in it, with a counted event in it, or currently in a snapshot status.
   * Buckets come from $dateTrunc in IST (weeks from Monday); zero-filling is
   * done by the caller.
   *
   * Per order and event type only the FIRST entry inside the range counts, so
   * an order is one dispatch / delivery / return at most.
   */
  async aggregate(
    coachId: string,
    start: Date,
    end: Date,
    unit: Granularity,
    orderFilter: Record<string, unknown> | null,
  ): Promise<{
    created: { _id: Date; n: number }[];
    eventBuckets: { _id: { k: string; b: Date }; n: number }[];
    eventProducts: { _id: { k: string; p: unknown }; units: number }[];
    eventCampaigns: { _id: { k: string; c: unknown }; n: number }[];
    snapshot: { inTransit: number; pending: number; pendingApproval: number }[];
  }> {
    const inRange = { $gte: start, $lt: end };
    const trunc = (date: string) => ({
      $dateTrunc: {
        date,
        unit,
        timezone: TIMEZONE,
        ...(unit === 'week' ? { startOfWeek: 'monday' } : {}),
      },
    });
    const firstInRange = (status: string) => ({
      $min: {
        $map: {
          input: {
            $filter: {
              input: { $ifNull: ['$statusHistory', []] },
              as: 'h',
              cond: {
                $and: [
                  { $eq: ['$$h.status', status] },
                  { $gte: ['$$h.at', start] },
                  { $lt: ['$$h.at', end] },
                ],
              },
            },
          },
          as: 'h',
          in: '$$h.at',
        },
      },
    });
    // One row per (order, counted event), for the event facets.
    const unwindEvents = [
      { $unwind: '$ev' },
      { $match: { 'ev.at': { $ne: null } } },
    ];
    const notRejected = { $ne: ['$approvalStatus', ApprovalStatus.REJECTED] };

    const match: Record<string, unknown> = {
      coachId: new Types.ObjectId(coachId),
      isDeleted: { $ne: true },
      $or: [
        { createdAt: inRange },
        {
          statusHistory: {
            $elemMatch: {
              status: { $in: EVENTS.map((e) => e.status) },
              at: inRange,
            },
          },
        },
        { status: { $in: [OrderStatus.DISPATCHED, ...PENDING_STATUSES] } },
      ],
    };
    const pipeline: any[] = [
      { $match: orderFilter ? { $and: [match, orderFilter] } : match },
      {
        $project: {
          _id: 0,
          createdAt: 1,
          status: 1,
          approvalStatus: 1,
          campaignId: 1,
          // Lines unticked at approval never shipped.
          items: {
            $filter: {
              input: { $ifNull: ['$items', []] },
              as: 'l',
              cond: { $ne: ['$$l.selected', false] },
            },
          },
          ev: EVENTS.map((e) => ({ k: e.key, at: firstInRange(e.status) })),
        },
      },
      {
        $facet: {
          created: [
            {
              $match: {
                createdAt: inRange,
                approvalStatus: { $ne: ApprovalStatus.REJECTED },
              },
            },
            { $group: { _id: trunc('$createdAt'), n: { $sum: 1 } } },
          ],
          eventBuckets: [
            ...unwindEvents,
            {
              $group: {
                _id: { k: '$ev.k', b: trunc('$ev.at') },
                n: { $sum: 1 },
              },
            },
          ],
          eventProducts: [
            ...unwindEvents,
            { $unwind: '$items' },
            { $match: { 'items.productId': { $ne: null } } },
            {
              $group: {
                _id: { k: '$ev.k', p: '$items.productId' },
                units: { $sum: '$items.quantity' },
              },
            },
          ],
          eventCampaigns: [
            ...unwindEvents,
            { $match: { campaignId: { $ne: null } } },
            {
              $group: {
                _id: { k: '$ev.k', c: '$campaignId' },
                n: { $sum: 1 },
              },
            },
          ],
          snapshot: [
            {
              $group: {
                _id: null,
                inTransit: {
                  $sum: {
                    $cond: [{ $eq: ['$status', OrderStatus.DISPATCHED] }, 1, 0],
                  },
                },
                pending: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', PENDING_STATUSES] },
                          notRejected,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                pendingApproval: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', PENDING_STATUSES] },
                          {
                            $eq: ['$approvalStatus', ApprovalStatus.PENDING],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ];
    const [out] = await this.orderModel.aggregate(pipeline).exec();
    return (
      out ?? {
        created: [],
        eventBuckets: [],
        eventProducts: [],
        eventCampaigns: [],
        snapshot: [],
      }
    );
  }
}
