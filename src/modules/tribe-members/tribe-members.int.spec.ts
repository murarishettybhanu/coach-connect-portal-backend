// Tribe members against a real MongoDB — the race-safety lives in the upsert,
// the unique index and the versioned write, which a mocked model can't prove.
// Runs only when MONGO_TEST_URI is set; uses its own database
// (shipkit_membertest, dropped afterwards) so it never collides with the
// size-stock suite sharing the same URI, e.g.:
//   MONGO_TEST_URI=mongodb://localhost:27017/shipkit_sizetest npx jest tribe-members
import mongoose, { Model } from 'mongoose';
import { Order, OrderSchema } from '../../schemas/order.schema';
import {
  TribeMember,
  TribeMemberSchema,
} from '../../schemas/tribe-member.schema';
import { TribeMembersService } from './tribe-members.service';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('tribe members (real MongoDB)', () => {
  let conn: mongoose.Connection;
  let orders: Model<Order>;
  let members: Model<TribeMember>;
  let svc: TribeMembersService;
  const tribe = new mongoose.Types.ObjectId();
  const otherTribe = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_membertest' })
      .asPromise();
    orders = conn.model<Order>('Order', OrderSchema);
    members = conn.model<TribeMember>('TribeMember', TribeMemberSchema);
    await members.init(); // the unique { coachId, phone } index must exist
    svc = new TribeMembersService(members, orders, {} as any);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  beforeEach(async () => {
    await orders.deleteMany({});
    await members.deleteMany({});
  });

  let day = 0;
  const place = async (addr: any, extra: any = {}) => {
    const _id = new mongoose.Types.ObjectId();
    await orders.collection.insertOne({
      _id,
      coachId: tribe,
      type: 'STORE_SALE',
      status: 'NEW',
      items: [],
      isDeleted: false,
      addressPending: false,
      createdAt: new Date(Date.UTC(2026, 0, ++day)),
      shippingAddress: {
        fullName: 'Ravi',
        phone: '9876543210',
        addressLine1: '1 MG Road',
        city: 'Pune',
        state: 'MH',
        pincode: '411001',
        ...addr,
      },
      ...extra,
    } as any);
    return _id;
  };
  const member = async () => {
    const all = await members.find({}).lean();
    expect(all).toHaveLength(1);
    return all[0] as any;
  };

  it('creates on the first order, merges later ones under the normalised phone', async () => {
    const a = await place({ email: 'r@x.in' });
    expect(await svc.recordOrder(a)).toMatchObject({
      created: true,
      linked: true,
      updated: true,
    });

    const b = await place({
      phone: '+91 98765 43210',
      fullName: 'Ravi Kumar',
      addressLine1: ' 1  mg road ',
    });
    expect(await svc.recordOrder(b)).toMatchObject({
      created: false,
      linked: true,
      updated: true,
    });

    const m = await member();
    expect(m.phone).toBe('9876543210');
    expect(m.name).toBe('Ravi Kumar');
    expect(m.email).toBe('r@x.in');
    expect(m.orderCount).toBe(2);
    expect(m.addresses).toHaveLength(1); // same address, looser spelling
    expect(m.addresses[0].addressLine1).toBe('1  mg road');
    expect((await orders.findById(a).lean())!.memberId).toEqual(m._id);
    expect((await orders.findById(b).lean())!.memberId).toEqual(m._id);
  });

  it('linking an order touches nothing but memberId', async () => {
    const a = await place({});
    const before: any = await orders.collection.findOne({ _id: a });
    await svc.recordOrder(a);
    const after: any = await orders.collection.findOne({ _id: a });
    const { memberId, ...rest } = after;
    expect(memberId).toBeDefined();
    expect(rest).toEqual(before);
  });

  it('keeps distinct addresses newest first', async () => {
    await svc.recordOrder(await place({}));
    await svc.recordOrder(
      await place({ addressLine1: '22 Park St', pincode: '700016' }),
    );
    const m = await member();
    expect(m.addresses.map((x: any) => x.addressLine1)).toEqual([
      '22 Park St',
      '1 MG Road',
    ]);
  });

  it('the same phone in another tribe is another member', async () => {
    await svc.recordOrder(await place({}));
    await svc.recordOrder(await place({}, { coachId: otherTribe }));
    expect(await members.countDocuments()).toBe(2);
  });

  it('address-pending claims add no address until one is attached', async () => {
    const id = await place(
      {
        addressLine1: undefined,
        city: undefined,
        state: undefined,
        pincode: undefined,
      },
      { addressPending: true },
    );
    await svc.recordOrder(id);
    expect((await member()).addresses).toEqual([]);

    await orders.updateOne(
      { _id: id },
      {
        $set: {
          addressPending: false,
          'shippingAddress.addressLine1': '5 Lake Rd',
          'shippingAddress.city': 'Pune',
          'shippingAddress.state': 'MH',
          'shippingAddress.pincode': '411002',
        },
      },
    );
    await svc.recordOrder(id);
    expect((await member()).addresses.map((x: any) => x.pincode)).toEqual([
      '411002',
    ]);
  });

  it('counts exclude deleted orders, and restore brings them back', async () => {
    const a = await place({});
    const b = await place({});
    await svc.recordOrder(a);
    await svc.recordOrder(b);
    await orders.updateOne({ _id: b }, { $set: { isDeleted: true } });
    await svc.recordOrder(b);
    let m = await member();
    expect(m.orderCount).toBe(1);
    expect(m.lastOrderAt).toEqual(
      ((await orders.findById(a).lean()) as any).createdAt,
    );

    await orders.updateOne({ _id: b }, { $set: { isDeleted: false } });
    await svc.recordOrder(b);
    m = await member();
    expect(m.orderCount).toBe(2);
  });

  it('is idempotent: a re-record writes nothing', async () => {
    const a = await place({});
    await svc.recordOrder(a);
    const before = await member();
    expect(await svc.recordOrder(a)).toMatchObject({
      created: false,
      linked: false,
      updated: false,
    });
    const after = await member();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.__v).toBe(before.__v);
  });

  it('concurrent orders for one phone make one member that counts them all', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => place({})));
    await Promise.all(ids.map((id) => svc.recordOrder(id)));
    const m = await member();
    expect(m.orderCount).toBe(12);
    expect(await orders.countDocuments({ memberId: m._id })).toBe(12);
  });

  it('moves an order whose phone changed and drops the emptied member', async () => {
    const a = await place({});
    await svc.recordOrder(a);
    await orders.updateOne(
      { _id: a },
      { $set: { 'shippingAddress.phone': '9123456789' } },
    );
    await svc.recordOrder(a);
    const m = await member();
    expect(m.phone).toBe('9123456789');
    expect(m.orderCount).toBe(1);
  });
});
