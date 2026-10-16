import mongoose, { Connection, Model, Types } from 'mongoose';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderSchema,
  OrderStatus,
  OrderType,
} from '../../schemas/order.schema';
import { TribeSchema } from '../../schemas/tribe.schema';
import { CampaignSchema } from '../../schemas/campaign.schema';
import { ProductSchema } from '../../schemas/product.schema';

// Real MongoDB: removing a line is one guarded $pull + $inc and a rounding
// pipeline update — semantics a mocked model can't check. Skipped without
// MONGO_TEST_URI; uses (and drops) its own shipkit_itemsedittest database.
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('OrdersService add/remove items (real Mongo)', () => {
  let conn: Connection;
  let orders: Model<Order>;
  let svc: OrdersService;
  const TRIBE = new Types.ObjectId();
  const TEE = new Types.ObjectId();
  const products = {
    findOne: jest.fn(),
    decrementStock: jest.fn().mockResolvedValue(undefined),
    incrementStock: jest.fn().mockResolvedValue(undefined),
  };
  const ledger: any[] = [];
  const transactions = {
    create: jest.fn(async (t: any) => ledger.push(t)),
    netCommissionForOrder: jest.fn(async () =>
      ledger.reduce((n, t) => n + t.amount, 0),
    ),
  };

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_itemsedittest' })
      .asPromise();
    orders = conn.model<Order>('Order', OrderSchema);
    conn.model('Tribe', TribeSchema);
    conn.model('Campaign', CampaignSchema);
    conn.model('Product', ProductSchema);
    const none: any = {};
    svc = new OrdersService(
      orders as any,
      none,
      products as any,
      transactions as any,
      none,
      none,
      none,
      none,
      none,
      none,
    );
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('adds a free extra, then removes paid lines down to one — totals rounded, never the last line', async () => {
    const o = await orders.create({
      coachId: TRIBE,
      type: OrderType.STORE_SALE,
      status: OrderStatus.NEW,
      items: [
        {
          productId: TEE,
          quantity: 1,
          baseCost: 100.1,
          retailPrice: 299.9,
          commission: 199.8,
        },
        {
          productId: TEE,
          quantity: 2,
          baseCost: 100.1,
          retailPrice: 299.9,
          commission: 399.6,
        },
      ],
      totalAmount: 899.7,
      totalCost: 300.3,
      totalCommission: 599.4,
      shippingAddress: { fullName: 'Asha' },
    } as any);
    ledger.push({ type: 'COMMISSION', amount: 599.4 });
    const id = String(o._id);

    products.findOne.mockResolvedValue({
      _id: TEE,
      coachId: TRIBE,
      name: 'Tee',
      baseProductionCost: 100.1,
    });
    const added: any = await svc.addItem(
      id,
      { productId: String(TEE), quantity: 1 },
      'Asha',
    );
    expect(added.items).toHaveLength(3);
    expect(added.items[2]).toMatchObject({
      retailPrice: 0,
      commission: 0,
      extra: true,
    });
    expect(added.totalCost).toBeCloseTo(400.4);

    const [first, second] = added.items;
    let after: any = await svc.removeItem(id, String(first._id), 'Asha');
    expect(after.items).toHaveLength(2);
    expect(after.totalAmount).toBe(599.8);
    expect(after.totalCommission).toBe(399.6);
    after = await svc.removeItem(id, String(second._id), 'Asha');
    expect(after.totalAmount).toBe(0);
    expect(after.totalCommission).toBe(0);
    expect(after.totalCost).toBe(100.1); // just the extra left
    expect(ledger.reduce((n, t) => n + t.amount, 0)).toBeCloseTo(0);
    expect(after.statusHistory.map((h: any) => h.status)).toEqual([
      'ITEM_ADDED',
      'ITEM_REMOVED',
      'ITEM_REMOVED',
    ]);

    // The last line can't go.
    await expect(
      svc.removeItem(id, String(after.items[0]._id), 'Asha'),
    ).rejects.toThrow('at least one product');
  });

  it('two admins removing the last two lines at once leave one', async () => {
    const o = await orders.create({
      coachId: TRIBE,
      type: OrderType.WELCOME_KIT,
      status: OrderStatus.PACKED,
      items: [
        { productId: TEE, quantity: 1, baseCost: 10, retailPrice: 0 },
        { productId: TEE, quantity: 1, baseCost: 10, retailPrice: 0 },
      ],
      shippingAddress: { fullName: 'Ravi' },
    } as any);
    const [a, b] = o.items as any[];
    const results = await Promise.allSettled([
      svc.removeItem(String(o._id), String(a._id), 'x'),
      svc.removeItem(String(o._id), String(b._id), 'y'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const left = await orders.findById(o._id).lean();
    expect(left!.items).toHaveLength(1);
  });
});
