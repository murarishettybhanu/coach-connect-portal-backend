// The analytics aggregation against a real MongoDB — $dateTrunc time zones,
// $facet and the first-in-range event logic only prove themselves on a real
// server. Runs only when MONGO_TEST_URI is set; uses its own database
// (shipkit_analyticstest, dropped afterwards), e.g.:
//   MONGO_TEST_URI=mongodb://localhost:27017/shipkit_sizetest npx jest analytics.int
import mongoose, { Model } from 'mongoose';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Product, ProductSchema } from '../../schemas/product.schema';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { AnalyticsService } from './analytics.service';
import { RestockService } from '../restock/restock.service';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('tribe analytics (real MongoDB)', () => {
  let conn: mongoose.Connection;
  let svc: AnalyticsService;
  let restock: RestockService;
  const { ObjectId } = mongoose.Types;
  const tribe = new ObjectId();
  const otherTribe = new ObjectId();
  const p1 = new ObjectId();
  const p2 = new ObjectId();
  const kit = new ObjectId();
  const kitCampaign = new ObjectId();
  const NOW = new Date('2026-10-05T12:00:00Z'); // 17:30 IST, Monday
  const T = String(tribe);
  const range = { from: '2026-09-28', to: '2026-10-05' };
  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_analyticstest' })
      .asPromise();
    const orders = conn.model<Order>('Order', OrderSchema);
    const campaigns = conn.model<Campaign>('Campaign', CampaignSchema);
    const products = conn.model<Product>('Product', ProductSchema);
    const kits = conn.model<TribeKit>('TribeKit', TribeKitSchema);
    const tribes = conn.model<Tribe>('Tribe', TribeSchema);
    // Let the background index builds finish, or one could recreate the
    // database after afterAll drops it.
    await Promise.all(
      [orders, campaigns, products, kits, tribes].map((m: Model<any>) =>
        m.init(),
      ),
    );
    svc = new AnalyticsService(
      orders as Model<Order>,
      campaigns,
      products,
      kits,
      tribes,
    );
    const noRequests = {
      findOne: () => ({
        sort: () => ({ lean: () => ({ exec: async () => null }) }),
      }),
    } as any;
    restock = new RestockService(
      noRequests,
      orders,
      campaigns,
      products,
      kits,
      tribes,
    );

    await products.collection.insertMany([
      {
        _id: p1,
        coachId: tribe,
        name: 'Tee',
        sku: 'AN-TEE',
        stockLevel: 10,
        isDeleted: false,
      },
      {
        _id: p2,
        coachId: tribe,
        name: 'Mug',
        sku: 'AN-MUG',
        stockLevel: 50,
        isDeleted: false,
      },
      // Deleted products are no rows.
      {
        coachId: tribe,
        name: 'Old',
        sku: 'AN-OLD',
        stockLevel: 1,
        isDeleted: true,
      },
    ] as any[]);
    await kits.collection.insertOne({
      _id: kit,
      coachId: tribe,
      name: 'Welcome Kit',
      items: [{ productId: p1, quantity: 2 }],
      isDeleted: false,
    } as any);
    await campaigns.collection.insertOne({
      _id: kitCampaign,
      coachId: tribe,
      kitId: kit,
      name: 'Kit claim',
      type: 'WELCOME_KIT',
    } as any);

    const order = (o: any) => ({
      coachId: tribe,
      type: 'STORE_SALE',
      isDeleted: false,
      approvalStatus: null,
      items: [],
      statusHistory: [],
      ...o,
    });
    await orders.collection.insertMany([
      // A: created 23:59:59 IST on 28 Sep. Dispatched at 00:00 IST 30 Sep and
      // again on 1 Oct (counts once, on 30 Sep). Delivered 00:00 IST 1 Oct —
      // still 30 Sep in UTC, so a UTC bucket would put it in September.
      order({
        campaignId: kitCampaign,
        type: 'WELCOME_KIT',
        approvalStatus: 'APPROVED',
        status: 'DELIVERED',
        createdAt: at('2026-09-28T18:29:59Z'),
        statusHistory: [
          { status: 'NEW', at: at('2026-09-28T18:29:59Z') },
          { status: 'DISPATCHED', at: at('2026-09-29T18:30:00Z') },
          { status: 'DISPATCHED', at: at('2026-10-01T05:00:00Z') },
          { status: 'DELIVERED', at: at('2026-09-30T18:30:00Z') },
        ],
        items: [
          { productId: p1, quantity: 2 },
          // Unticked at approval: never shipped, never counted.
          { productId: p2, quantity: 5, selected: false },
        ],
      }),
      // B: created 23:59 IST 27 Sep (out of range), dispatched before the
      // range, returned inside it.
      order({
        status: 'RETURNED',
        createdAt: at('2026-09-27T18:29:00Z'),
        statusHistory: [
          { status: 'DISPATCHED', at: at('2026-09-27T10:00:00Z') },
          { status: 'RETURNED', at: at('2026-10-03T10:00:00Z') },
        ],
        items: [{ productId: p1, quantity: 1 }],
      }),
      // C: rejected claim — no order, not pending.
      order({
        type: 'WELCOME_KIT',
        approvalStatus: 'REJECTED',
        status: 'CANCELLED',
        createdAt: at('2026-10-02T05:00:00Z'),
        items: [{ productId: p2, quantity: 1 }],
      }),
      // D: soft-deleted — excluded from everything.
      order({
        isDeleted: true,
        status: 'DISPATCHED',
        createdAt: at('2026-10-02T05:00:00Z'),
        statusHistory: [
          { status: 'DISPATCHED', at: at('2026-10-02T06:00:00Z') },
        ],
        items: [{ productId: p2, quantity: 9 }],
      }),
      // E: claim awaiting approval, created today.
      order({
        type: 'WELCOME_KIT',
        approvalStatus: 'PENDING',
        status: 'NEW',
        createdAt: at('2026-10-05T10:00:00Z'),
        items: [{ productId: p2, quantity: 1 }],
      }),
      // F: packed long ago — pending now, not an order in range.
      order({
        status: 'PACKED',
        createdAt: at('2026-01-01T05:00:00Z'),
        items: [{ productId: p2, quantity: 1 }],
      }),
      // G: in transit since August — in transit now, nothing in range.
      order({
        status: 'DISPATCHED',
        createdAt: at('2026-08-01T05:00:00Z'),
        statusHistory: [
          { status: 'DISPATCHED', at: at('2026-08-02T05:00:00Z') },
        ],
        items: [{ productId: p2, quantity: 1 }],
      }),
      // I: 00:00 IST on 6 Oct — after the range.
      order({
        status: 'NEW',
        createdAt: at('2026-10-05T18:30:00Z'),
        items: [{ productId: p1, quantity: 1 }],
      }),
      // Another tribe's order in range.
      order({
        coachId: otherTribe,
        status: 'DISPATCHED',
        createdAt: at('2026-10-01T05:00:00Z'),
        statusHistory: [
          { status: 'DISPATCHED', at: at('2026-10-01T06:00:00Z') },
        ],
        items: [{ productId: p1, quantity: 3 }],
      }),
    ] as any[]);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const zero = { orders: 0, dispatched: 0, delivered: 0, returned: 0 };

  it('KPIs: events in range, snapshots now, rejected and deleted excluded', async () => {
    const res = await svc.tribe(T, range as any, NOW);
    expect(res.kpis).toEqual({
      totalOrders: 2, // A, E
      dispatched: 1, // A once
      delivered: 1, // A
      returned: 1, // B
      returnRate: 1,
      inTransit: 1, // G
      pending: 3, // E, F, and I (a snapshot: created after the range is fine)
      pendingApproval: 1, // E
    });
  });

  it('daily trend: IST days, zero-filled, first dispatch only', async () => {
    const res = await svc.tribe(T, range as any, NOW);
    expect(res.trend.map((t) => t.bucket)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    const by = Object.fromEntries(
      res.trend.map(({ bucket, label: _l, ...rest }) => [bucket, rest]),
    );
    expect(by['2026-09-28']).toEqual({ ...zero, orders: 1 });
    expect(by['2026-09-29']).toEqual(zero);
    expect(by['2026-09-30']).toEqual({ ...zero, dispatched: 1 });
    expect(by['2026-10-01']).toEqual({ ...zero, delivered: 1 });
    expect(by['2026-10-03']).toEqual({ ...zero, returned: 1 });
    expect(by['2026-10-05']).toEqual({ ...zero, orders: 1 });
  });

  it('weekly trend starts on Monday; monthly splits on IST month boundaries', async () => {
    const week = await svc.tribe(
      T,
      { from: '2026-09-30', to: '2026-10-05', granularity: 'week' } as any,
      NOW,
    );
    expect(week.trend).toEqual([
      {
        bucket: '2026-09-28',
        label: 'Wk of 28 Sep',
        orders: 0, // A was created on the 28th, before `from`
        dispatched: 1,
        delivered: 1,
        returned: 1,
      },
      { bucket: '2026-10-05', label: 'Wk of 05 Oct', ...zero, orders: 1 },
    ]);
    const month = await svc.tribe(
      T,
      { ...range, granularity: 'month' } as any,
      NOW,
    );
    expect(month.trend).toEqual([
      {
        bucket: '2026-09-01',
        label: 'Sep 2026',
        ...zero,
        orders: 1,
        dispatched: 1,
      },
      {
        bucket: '2026-10-01',
        label: 'Oct 2026',
        ...zero,
        orders: 1,
        delivered: 1,
        returned: 1,
      },
    ]);
  });

  it('items: units, return rates, stock and levels matching the restock overview', async () => {
    const [res, overview] = await Promise.all([
      svc.tribe(T, range as any, NOW),
      restock.overview(T, NOW),
    ]);
    expect(res.items).toEqual([
      {
        kind: 'KIT',
        id: String(kit),
        name: 'Welcome Kit',
        dispatchedUnits: 1,
        deliveredUnits: 1,
        returnedUnits: 0,
        returnRate: 0,
        stock: 5,
        consumedUnits: 1,
        level: 'CRITICAL',
        daysLeft: 35,
      },
      {
        kind: 'PRODUCT',
        id: String(p1),
        name: 'Tee',
        dispatchedUnits: 2,
        deliveredUnits: 2,
        returnedUnits: 1,
        returnRate: 0.5,
        stock: 10,
        consumedUnits: 2,
        level: 'LOW',
        daysLeft: 35,
      },
      {
        kind: 'PRODUCT',
        id: String(p2),
        name: 'Mug',
        dispatchedUnits: 0,
        deliveredUnits: 0,
        returnedUnits: 0,
        returnRate: 0,
        stock: 50,
        consumedUnits: 0,
        level: 'HEALTHY',
        daysLeft: null,
      },
    ]);
    for (const i of res.items) {
      const o = overview.items.find((x) => x.id === i.id)!;
      expect([i.stock, i.level, i.daysLeft]).toEqual([
        o.stock,
        o.level,
        o.daysLeft,
      ]);
    }
    expect(res.stockAlerts).toEqual({ OUT: 0, CRITICAL: 1, LOW: 1 });
  });

  it('filters: a kit counts its campaign’s orders; an unticked line doesn’t match', async () => {
    const byKit = await svc.tribe(
      T,
      { ...range, kitIds: String(kit) } as any,
      NOW,
    );
    expect(byKit.kpis).toMatchObject({
      totalOrders: 1,
      dispatched: 1,
      delivered: 1,
      returned: 0,
      inTransit: 0,
      pending: 0,
    });
    expect(byKit.items.map((i) => i.id)).toEqual([String(kit)]);

    const byMug = await svc.tribe(
      T,
      { ...range, productIds: String(p2) } as any,
      NOW,
    );
    // Only E (pending, created today) and F (pending) hold a ticked mug line
    // among the counted orders; A's mug line was unticked.
    expect(byMug.kpis).toMatchObject({
      totalOrders: 1,
      dispatched: 0,
      pending: 2,
      inTransit: 1, // G
    });
    expect(byMug.items.map((i) => i.id)).toEqual([String(p2)]);
  });
});
