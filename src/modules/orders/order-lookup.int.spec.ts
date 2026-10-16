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
import { UserSchema } from '../../schemas/user.schema';

// Real MongoDB: the lookup uses regex $in and an $expr on the id string, which a
// mock can't evaluate. Skipped without MONGO_TEST_URI; own database, dropped.
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('OrdersService advanced search (real Mongo)', () => {
  let conn: Connection;
  let orders: Model<Order>;
  let svc: OrdersService;
  const TRIBE = new Types.ObjectId();
  const ids = {
    asha: new Types.ObjectId(),
    ravi: new Types.ObjectId(),
    priya: new Types.ObjectId(),
  };

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_lookuptest' })
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
    const base = {
      coachId: TRIBE,
      type: OrderType.WELCOME_KIT,
      status: OrderStatus.NEW,
      items: [],
    };
    await orders.create([
      {
        ...base,
        _id: ids.asha,
        shippingAddress: {
          fullName: 'Asha',
          phone: '+91 98765 43210',
          pincode: '500034',
          email: 'Asha@x.com',
        },
      },
      {
        ...base,
        _id: ids.ravi,
        trackingNumber: 'ea100000001in ',
        shippingAddress: { fullName: 'Ravi', phone: '9000000001' },
      },
      {
        ...base,
        _id: ids.priya,
        status: OrderStatus.DELIVERED,
        shippingAddress: { fullName: 'Priya', phone: '9000000002' },
      },
    ] as any);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('matches phones (as typed), tracking (any case/padding), short ids and emails — with the other filters', async () => {
    const short = String(ids.priya).slice(-8);
    const res: any = await svc.findAllPaginated({
      lookup: `9876543210\nEA100000001IN, ${short}, nobody@x.com 9999999999 garbage`,
      limit: 50,
    });
    expect(res.data.map((o: any) => o.shippingAddress.fullName).sort()).toEqual(
      ['Asha', 'Priya', 'Ravi'],
    );
    expect(res.lookup).toEqual({
      values: 5,
      unknown: ['garbage'],
      unmatched: ['nobody@x.com', '9999999999'],
    });

    const notDelivered: any = await svc.findAllPaginated({
      lookup: `9876543210 ${short}`,
      status: 'NEW',
      limit: 50,
    });
    expect(
      notDelivered.data.map((o: any) => o.shippingAddress.fullName),
    ).toEqual(['Asha']);
    expect(notDelivered.lookup.unmatched).toEqual([short]);
  });

  it('only unrecognised values → no orders, not every order', async () => {
    const res: any = await svc.findAllPaginated({
      lookup: 'garbage',
      limit: 50,
    });
    expect(res.total).toBe(0);
    expect(res.lookup.unknown).toEqual(['garbage']);
  });
});
