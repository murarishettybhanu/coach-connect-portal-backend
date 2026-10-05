import mongoose, { Connection, Model, Types } from 'mongoose';
import { OrdersService } from './orders.service';
import {
  ApprovalStatus,
  Order,
  OrderSchema,
  OrderStatus,
  OrderType,
} from '../../schemas/order.schema';
import { TribeSchema } from '../../schemas/tribe.schema';
import { CampaignSchema } from '../../schemas/campaign.schema';
import { ProductSchema } from '../../schemas/product.schema';
import { UserSchema } from '../../schemas/user.schema';

// Real MongoDB: duplicates are found by an aggregation (grouping, id casting),
// which a mocked model can't exercise. Skipped without MONGO_TEST_URI.
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('OrdersService.findDuplicates (real Mongo)', () => {
  let conn: Connection;
  let orders: Model<Order>;
  let svc: OrdersService;
  const T1 = new Types.ObjectId();
  const T2 = new Types.ObjectId();
  const CA = new Types.ObjectId();
  const CB = new Types.ObjectId();

  let n = 0;
  const order = (name: string, phone: string, extra: any = {}) => ({
    coachId: T1,
    campaignId: CA,
    type: OrderType.WELCOME_KIT,
    status: OrderStatus.NEW,
    approvalStatus: ApprovalStatus.APPROVED,
    isDeleted: false,
    items: [],
    shippingAddress: { fullName: name, phone },
    // Distinct, increasing times: later inserts are newer.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n++)),
    ...extra,
  });

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_duplicatestest' })
      .asPromise();
    orders = conn.model<Order>('Order', OrderSchema);
    conn.model('Tribe', TribeSchema);
    conn.model('Campaign', CampaignSchema);
    conn.model('Product', ProductSchema);
    conn.model('User', UserSchema);
    const none: any = {};
    svc = new OrdersService(
      orders as any,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    await orders.collection.insertMany([
      order('Asha 1', '9800000001'),
      order('Ravi 1', '9800000002'),
      order('Asha 2', '+91 9800000001', { status: OrderStatus.DELIVERED }),
      order('Solo', '9800000003'),
      order('Ravi 2', '9800000002', { campaignId: CB }),
      // Same number at another tribe — not a duplicate of T1's Asha.
      order('Asha other tribe', '9800000001', { coachId: T2 }),
      // Rejected and deleted orders don't count.
      order('Solo rejected', '9800000003', {
        approvalStatus: ApprovalStatus.REJECTED,
      }),
      order('Solo deleted', '9800000003', { isDeleted: true }),
      order('No phone 1', ''),
      order('No phone 2', ''),
      order('Pending 1', '9800000004', {
        approvalStatus: ApprovalStatus.PENDING,
      }),
      order('Pending 2', '9800000004'),
    ] as any[]);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const names = (res: any) =>
    res.data.map((o: any) => o.shippingAddress.fullName);

  it('lists numbers on more than one order of a tribe, grouped, newest group first', async () => {
    const res = await svc.findDuplicates();
    expect(names(res)).toEqual([
      'Pending 2',
      'Pending 1',
      'Ravi 2',
      'Ravi 1',
      'Asha 2',
      'Asha 1',
    ]);
    expect(res).toMatchObject({ total: 6, groups: 3 });
  });

  it('tribe and campaign set the scope', async () => {
    let res = await svc.findDuplicates({ campaignId: String(CA) });
    expect(names(res)).toEqual(['Pending 2', 'Pending 1', 'Asha 2', 'Asha 1']);
    res = await svc.findDuplicates({ coachId: String(T2) });
    expect(names(res)).toEqual([]);
  });

  it('status and search pick rows without changing which numbers repeat', async () => {
    let res = await svc.findDuplicates({ status: OrderStatus.DELIVERED });
    expect(names(res)).toEqual(['Asha 2']);
    expect(res.groups).toBe(1);
    res = await svc.findDuplicates({ status: OrderStatus.NEW });
    expect(names(res)).toEqual(['Pending 2', 'Ravi 2', 'Ravi 1', 'Asha 1']);
    res = await svc.findDuplicates({ status: 'PENDING' });
    expect(names(res)).toEqual(['Pending 1']);
    res = await svc.findDuplicates({ search: 'asha' });
    expect(names(res)).toEqual(['Asha 2', 'Asha 1']);
  });

  it('paginates the grouped list', async () => {
    const p2 = await svc.findDuplicates({ page: 2, limit: 4 });
    expect(names(p2)).toEqual(['Asha 2', 'Asha 1']);
    expect(p2).toMatchObject({ total: 6, totalPages: 2 });
  });
});
