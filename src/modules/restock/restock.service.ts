import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Order, OrderStatus } from '../../schemas/order.schema';
import { Campaign } from '../../schemas/campaign.schema';
import { Product } from '../../schemas/product.schema';
import { TribeKit } from '../../schemas/tribe-kit.schema';
import { Tribe } from '../../schemas/tribe.schema';
import {
  OPEN_RESTOCK_STATUSES,
  RestockItemKind,
  RestockRequest,
  RestockStatus,
} from '../../schemas/restock-request.schema';
import { buildableKits } from '../tribe-kits/tribe-kits.service';
import {
  PACE_DAYS,
  RestockLevel,
  WINDOW_DAYS,
  compareItems,
  stockHealth,
} from './restock-math';
import {
  CreateRestockRequestDto,
  UpdateRestockRequestDto,
} from './dto/restock.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

// Unread = still NEW and never opened by an admin (same as enquiries).
const UNREAD = {
  status: RestockStatus.NEW,
  seenAt: { $exists: false },
} as const;
const UNREAD_PREVIEW = 5;
const MINE_LIMIT = 20;

// The populated tribe on admin responses.
const TRIBE_POPULATE = {
  path: 'coachId',
  select: 'username brand name userId',
  populate: { path: 'userId', select: 'name phoneNumber' },
};

export interface RestockOverviewItem {
  kind: 'KIT' | 'PRODUCT';
  id: string;
  name: string;
  imageUrl?: string;
  stock: number;
  shippedThisWeek: number;
  weeklyPace: number;
  daysLeft: number | null;
  lowAt: number;
  criticalAt: number;
  level: RestockLevel;
  suggestedQty: number;
}

/** Units dispatched per product / kit claims per kit, in one window. */
interface WindowCounts {
  byProduct: Map<string, number>;
  byKit: Map<string, number>;
  units: number;
  orders: number;
}

const emptyCounts = (): WindowCounts => ({
  byProduct: new Map(),
  byKit: new Map(),
  units: 0,
  orders: 0,
});

const bump = (m: Map<string, number>, key: string, n: number) =>
  m.set(key, (m.get(key) ?? 0) + n);

@Injectable()
export class RestockService {
  constructor(
    @InjectModel(RestockRequest.name)
    private restockModel: Model<RestockRequest>,
    // Read-only below: the restock module never writes orders, products,
    // kits, campaigns or tribes.
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(TribeKit.name) private kitModel: Model<TribeKit>,
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
  ) {}

  /** The signed-in TRIBE user's own tribe id — never taken from the request. */
  async tribeIdForUser(userId: string): Promise<string> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id')
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');
    return String((tribe as any)._id);
  }

  // ── Stock ───────────────────────────────────────────────────────────────

  private loadProducts(coachId: string) {
    return this.productModel
      .find({ coachId, isDeleted: { $ne: true } } as any)
      .select('name stockLevel imageUrl')
      .lean()
      .exec();
  }

  private loadKits(coachId: string) {
    return this.kitModel
      .find({ coachId, isDeleted: { $ne: true } } as any)
      .select('name imageUrl items')
      .populate({ path: 'items.productId', select: 'stockLevel' })
      .lean()
      .exec();
  }

  /**
   * Every order of the tribe dispatched in the last 28 days, in ONE query
   * (`statusHistory` holds the only record of when a dispatch happened), then
   * split into the 7-day and 28-day counts in memory.
   *
   * - product: Σ quantity of the order's lines for that product. Lines
   *   unticked at approval (`selected: false`) were never sent, so they don't
   *   count.
   * - kit: one per order whose campaign is linked to the kit.
   */
  private async dispatchCounts(coachId: string, now: Date) {
    const weekStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const paceStart = new Date(now.getTime() - PACE_DAYS * DAY_MS);

    const [orders, campaigns] = await Promise.all([
      this.orderModel
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
        .exec(),
      // The tribe's kit-linked campaigns, looked up once.
      this.campaignModel
        .find({ coachId, kitId: { $ne: null } } as any)
        .select('kitId')
        .lean()
        .exec(),
    ]);

    const kitOfCampaign = new Map<string, string>(
      campaigns.map((c: any) => [String(c._id), String(c.kitId)]),
    );
    const week = emptyCounts();
    const pace = emptyCounts();

    for (const order of orders as any[]) {
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

  // ── Tribe: overview ────────────────────────────────────────────────────

  async overview(coachId: string, now = new Date()) {
    const [products, kits, { week, pace }, pendingRequest] = await Promise.all([
      this.loadProducts(coachId),
      this.loadKits(coachId),
      this.dispatchCounts(coachId, now),
      this.restockModel
        .findOne({
          coachId,
          status: { $in: OPEN_RESTOCK_STATUSES },
        } as any)
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
    ]);

    const item = (
      kind: 'KIT' | 'PRODUCT',
      doc: any,
      stock: number,
      counts: (w: WindowCounts) => number,
    ): RestockOverviewItem => {
      const shippedThisWeek = counts(week);
      return {
        kind,
        id: String(doc._id),
        name: doc.name ?? '',
        ...(doc.imageUrl ? { imageUrl: doc.imageUrl } : {}),
        stock,
        shippedThisWeek,
        ...stockHealth(stock, shippedThisWeek, counts(pace)),
      };
    };

    const kitItems = (kits as any[]).map((k) =>
      item('KIT', k, buildableKits(k), (w) => w.byKit.get(String(k._id)) ?? 0),
    );
    const productItems = (products as any[]).map((p) =>
      item(
        'PRODUCT',
        p,
        Number(p.stockLevel) || 0,
        (w) => w.byProduct.get(String(p._id)) ?? 0,
      ),
    );

    const items = [...kitItems, ...productItems].sort(compareItems);
    const counts: Record<RestockLevel, number> = {
      OUT: 0,
      CRITICAL: 0,
      LOW: 0,
      HEALTHY: 0,
    };
    for (const i of items) counts[i.level] += 1;

    return {
      generatedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      totals: {
        shippedThisWeek: week.units,
        ordersShippedThisWeek: week.orders,
      },
      highlight: pickHighlight(kitItems, productItems),
      items,
      counts,
      pendingRequest: pendingRequest ?? null,
    };
  }

  // ── Tribe: requests ────────────────────────────────────────────────────

  async createRequest(coachId: string, dto: CreateRestockRequestDto) {
    const keys = dto.items.map((i) => `${i.kind}:${i.id}`);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException(
        'Each product or kit can only appear once in a restock request',
      );
    }
    const productIds = dto.items
      .filter((i) => i.kind === RestockItemKind.PRODUCT)
      .map((i) => i.id);
    const kitIds = dto.items
      .filter((i) => i.kind === RestockItemKind.KIT)
      .map((i) => i.id);

    const [products, kits] = await Promise.all([
      productIds.length
        ? this.productModel
            .find({
              _id: { $in: productIds },
              coachId,
              isDeleted: { $ne: true },
            } as any)
            .select('name stockLevel')
            .lean()
            .exec()
        : Promise.resolve([]),
      kitIds.length
        ? this.kitModel
            .find({
              _id: { $in: kitIds },
              coachId,
              isDeleted: { $ne: true },
            } as any)
            .select('name items')
            .populate({ path: 'items.productId', select: 'stockLevel' })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);
    const productById = new Map(
      (products as any[]).map((p) => [String(p._id), p]),
    );
    const kitById = new Map((kits as any[]).map((k) => [String(k._id), k]));

    const items = dto.items.map((i) => {
      if (i.kind === RestockItemKind.PRODUCT) {
        const p = productById.get(String(i.id));
        if (!p) {
          throw new BadRequestException(
            'Every item must be one of your own products or kits',
          );
        }
        return {
          kind: i.kind,
          refId: p._id,
          name: p.name ?? '',
          quantity: i.quantity,
          stockAtRequest: Number(p.stockLevel) || 0,
        };
      }
      const k = kitById.get(String(i.id));
      if (!k) {
        throw new BadRequestException(
          'Every item must be one of your own products or kits',
        );
      }
      return {
        kind: i.kind,
        refId: k._id,
        name: k.name ?? '',
        quantity: i.quantity,
        stockAtRequest: buildableKits(k),
      };
    });

    // Explicit build — the body is never handed to Mongo as-is.
    return this.restockModel.create({
      coachId: coachId as any,
      items,
      ...(dto.note !== undefined && dto.note.trim() !== ''
        ? { note: dto.note.trim() }
        : {}),
      ...(dto.neededBy ? { neededBy: new Date(dto.neededBy) } : {}),
      status: RestockStatus.NEW,
    });
  }

  mine(coachId: string) {
    return this.restockModel
      .find({ coachId } as any)
      .sort({ createdAt: -1 })
      .limit(MINE_LIMIT)
      .lean()
      .exec();
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  list(filter: { status?: string; coachId?: string }) {
    const q: Record<string, unknown> = {};
    if (filter.status) {
      if (!Object.values(RestockStatus).includes(filter.status as any)) {
        throw new BadRequestException('Unknown restock status');
      }
      q.status = filter.status;
    }
    if (filter.coachId) {
      if (!isValidObjectId(filter.coachId)) {
        throw new BadRequestException('Invalid coachId');
      }
      q.coachId = filter.coachId;
    }
    return this.restockModel
      .find(q as any)
      .sort({ createdAt: -1 })
      .populate(TRIBE_POPULATE)
      .lean()
      .exec();
  }

  /** The portal's badge and pop-ups: unread count + the newest few. */
  async unread() {
    const [count, latest] = await Promise.all([
      this.restockModel.countDocuments(UNREAD as any).exec(),
      this.restockModel
        .find(UNREAD as any)
        .sort({ createdAt: -1 })
        .limit(UNREAD_PREVIEW)
        .select('coachId items createdAt')
        .populate({ path: 'coachId', select: 'username brand name' })
        .lean()
        .exec(),
    ]);
    return {
      count,
      latest: (latest as any[]).map((r) => ({
        _id: r._id,
        coachId: r.coachId,
        itemsCount: (r.items || []).length,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Opening a request marks it read; the first open's time is kept. */
  async markSeen(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Request not found');
    const updated = await this.restockModel
      .findOneAndUpdate(
        { _id: id, seenAt: { $exists: false } } as any,
        { $set: { seenAt: new Date() } },
        { new: true },
      )
      .populate(TRIBE_POPULATE)
      .exec();
    if (updated) return updated;
    const existing = await this.restockModel
      .findById(id)
      .populate(TRIBE_POPULATE)
      .exec();
    if (!existing) throw new NotFoundException('Request not found');
    return existing;
  }

  /** Status / admin note; handling a request also counts as opening it. */
  async update(id: string, dto: UpdateRestockRequestDto) {
    if (!isValidObjectId(id)) throw new NotFoundException('Request not found');
    const existing = await this.restockModel.findById(id).lean().exec();
    if (!existing) throw new NotFoundException('Request not found');
    const $set: Record<string, unknown> = {};
    if (dto.status) $set.status = dto.status;
    if (dto.adminNote !== undefined) $set.adminNote = dto.adminNote;
    if (!(existing as any).seenAt) $set.seenAt = new Date();
    const doc = await this.restockModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .populate(TRIBE_POPULATE)
      .exec();
    if (!doc) throw new NotFoundException('Request not found');
    return doc;
  }
}

/**
 * The celebration line: the kit shipped most this week (> 0), else the
 * product shipped most, else null. Ties go to the earlier name.
 */
export function pickHighlight(
  kits: RestockOverviewItem[],
  products: RestockOverviewItem[],
) {
  const top = (list: RestockOverviewItem[]) =>
    list
      .filter((i) => i.shippedThisWeek > 0)
      .sort(
        (a, b) =>
          b.shippedThisWeek - a.shippedThisWeek || a.name.localeCompare(b.name),
      )[0];
  const best = top(kits) ?? top(products);
  if (!best) return null;
  return {
    kind: best.kind,
    id: best.id,
    name: best.name,
    shippedThisWeek: best.shippedThisWeek,
    stock: best.stock,
    level: best.level,
  };
}
