import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { TribeMembersService } from './tribe-members.service';

/** A chainable stand-in for a Mongoose query that resolves to `value`. */
const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: jest.fn(() => q),
    populate: jest.fn(() => q),
    sort: jest.fn(() => q),
    skip: jest.fn(() => q),
    limit: jest.fn(() => q),
    lean: jest.fn(() => q),
  };
  return q;
};

const TRIBE = new Types.ObjectId();
const ORDER = new Types.ObjectId();
const MEMBER = new Types.ObjectId();

function setup() {
  const memberModel: any = {
    find: jest.fn(() => query([])),
    findOne: jest.fn(() => query(null)),
    findById: jest.fn(() => query(null)),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(() => query({ matchedCount: 1 })),
    deleteOne: jest.fn(() => query({ deletedCount: 1 })),
    countDocuments: jest.fn(() => query(0)),
    exists: jest.fn().mockResolvedValue({ _id: MEMBER }),
  };
  const orderModel: any = {
    findById: jest.fn(),
    find: jest.fn(() => query([])),
    updateOne: jest.fn(() => query({ matchedCount: 1 })),
  };
  const tribeModel: any = {
    findOne: jest.fn(() =>
      query({ _id: TRIBE, permissions: { members: true } }),
    ),
  };
  return {
    service: new TribeMembersService(memberModel, orderModel, tribeModel),
    memberModel,
    orderModel,
    tribeModel,
  };
}

const order = (extra: any = {}) => ({
  _id: ORDER,
  coachId: TRIBE,
  shippingAddress: { phone: '+91 98765 43210' },
  ...extra,
});

const linkedOrders = [
  {
    _id: ORDER,
    createdAt: new Date('2026-01-01'),
    shippingAddress: {
      fullName: 'Ravi',
      phone: '9876543210',
      addressLine1: '1 Road',
      city: 'Pune',
      state: 'MH',
      pincode: '411001',
    },
  },
];

describe('TribeMembersService.recordOrder', () => {
  it('creates the member on its first order and links the order', async () => {
    const { service, memberModel, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(order()));
    memberModel.findOneAndUpdate.mockReturnValue(
      query({
        value: { _id: MEMBER, __v: 0 },
        lastErrorObject: { updatedExisting: false },
      }),
    );
    memberModel.findById.mockReturnValue(
      query({ _id: MEMBER, __v: 0, name: '', addresses: [], orderCount: 0 }),
    );
    orderModel.find.mockReturnValue(query(linkedOrders));

    const res = await service.recordOrder(order());

    expect(res).toEqual({
      memberId: String(MEMBER),
      created: true,
      linked: true,
      updated: true,
    });
    // Upsert keyed on the normalised phone, so concurrent orders share one member.
    expect(memberModel.findOneAndUpdate).toHaveBeenCalledWith(
      { coachId: TRIBE, phone: '9876543210' },
      expect.objectContaining({ $setOnInsert: expect.any(Object) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(orderModel.updateOne).toHaveBeenCalledWith(
      { _id: ORDER },
      { $set: { memberId: MEMBER } },
      { timestamps: false },
    );
    // Written conditionally on the version it was computed from.
    const [filter, update] = memberModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: MEMBER, __v: 0 });
    expect(update.$set).toMatchObject({ name: 'Ravi', orderCount: 1 });
    expect(update.$inc).toEqual({ __v: 1 });
  });

  it('is a no-op when the order is linked and the member is current', async () => {
    const { service, memberModel, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(order({ memberId: MEMBER })));
    memberModel.findOne.mockReturnValue(query({ _id: MEMBER }));
    orderModel.find.mockReturnValue(query(linkedOrders));
    memberModel.findById.mockReturnValue(
      query({
        _id: MEMBER,
        __v: 1,
        name: 'Ravi',
        orderCount: 1,
        firstOrderAt: new Date('2026-01-01'),
        lastOrderAt: new Date('2026-01-01'),
        joinedAt: new Date('2026-01-01'),
        addresses: [
          {
            addressLine1: '1 Road',
            city: 'Pune',
            state: 'MH',
            pincode: '411001',
            lastUsedAt: new Date('2026-01-01'),
          },
        ],
      }),
    );

    const res = await service.recordOrder(order());
    expect(res).toEqual({
      memberId: String(MEMBER),
      created: false,
      linked: false,
      updated: false,
    });
    expect(memberModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(orderModel.updateOne).not.toHaveBeenCalled();
    expect(memberModel.updateOne).not.toHaveBeenCalled();
  });

  it('re-reads the winner when a concurrent upsert hits the unique index', async () => {
    const { service, memberModel, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(order()));
    memberModel.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ _id: MEMBER, __v: 0 }));
    const dup: any = new Error('E11000 duplicate key');
    dup.code = 11000;
    memberModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: () => Promise.reject(dup) }),
    });
    memberModel.findById.mockReturnValue(query({ _id: MEMBER, __v: 0 }));
    orderModel.find.mockReturnValue(query(linkedOrders));

    const res = await service.recordOrder(order());
    expect(res).toMatchObject({
      memberId: String(MEMBER),
      created: false,
      linked: true,
    });
  });

  it('retries the member write when another sync changed it first', async () => {
    const { service, memberModel, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(order({ memberId: MEMBER })));
    memberModel.findOne.mockReturnValue(query({ _id: MEMBER }));
    memberModel.findById
      .mockReturnValueOnce(query({ _id: MEMBER, __v: 0 }))
      .mockReturnValueOnce(query({ _id: MEMBER, __v: 1 }));
    memberModel.updateOne
      .mockReturnValueOnce(query({ matchedCount: 0 }))
      .mockReturnValueOnce(query({ matchedCount: 1 }));
    orderModel.find.mockReturnValue(query(linkedOrders));

    await service.recordOrder(order());
    expect(memberModel.updateOne).toHaveBeenCalledTimes(2);
    expect(memberModel.updateOne.mock.calls[1][0]).toEqual({
      _id: MEMBER,
      __v: 1,
    });
  });

  it('moves an order whose phone changed, and drops the emptied old member', async () => {
    const { service, memberModel, orderModel } = setup();
    const OLD = new Types.ObjectId();
    orderModel.findById.mockReturnValue(query(order({ memberId: OLD })));
    memberModel.findOne.mockReturnValue(query({ _id: MEMBER }));
    memberModel.findById.mockImplementation((id: any) =>
      query({ _id: id, __v: 2 }),
    );
    orderModel.find.mockImplementation((f: any) =>
      query(String(f.memberId) === String(MEMBER) ? linkedOrders : []),
    );

    const res = await service.recordOrder(order());
    expect(res).toMatchObject({ linked: true });
    expect(memberModel.deleteOne).toHaveBeenCalledWith({ _id: OLD, __v: 2 });
  });

  it('skips an order with no phone', async () => {
    const { service, memberModel, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(order({ shippingAddress: {} })));
    await expect(service.recordOrder(order())).resolves.toBeNull();
    expect(memberModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('skips a missing order or a bad id', async () => {
    const { service, orderModel } = setup();
    orderModel.findById.mockReturnValue(query(null));
    await expect(service.recordOrder(String(ORDER))).resolves.toBeNull();
    await expect(service.recordOrder('nope')).resolves.toBeNull();
  });
});

describe('TribeMembersService.findAll', () => {
  it('filters by several tribes, newest members first, default page size 20', async () => {
    const { service, memberModel } = setup();
    const q = query([]);
    memberModel.find.mockReturnValue(q);
    memberModel.countDocuments.mockReturnValue(query(45));
    const a = new Types.ObjectId().toString();
    const b = new Types.ObjectId().toString();

    const res = await service.findAll({ coachId: `${a}, ${b}` });

    expect(memberModel.find).toHaveBeenCalledWith({ coachId: { $in: [a, b] } });
    expect(q.sort).toHaveBeenCalledWith({ joinedAt: -1, _id: -1 });
    expect(q.limit).toHaveBeenCalledWith(20);
    expect(q.populate).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'coachId',
        populate: { path: 'userId', select: 'name' },
      }),
    );
    expect(res).toEqual({
      data: [],
      total: 45,
      page: 1,
      limit: 20,
      totalPages: 3,
    });
  });

  it('accepts repeated coachId params and pages', async () => {
    const { service, memberModel } = setup();
    const q = query([]);
    memberModel.find.mockReturnValue(q);
    const a = new Types.ObjectId().toString();
    const b = new Types.ObjectId().toString();
    const res = await service.findAll({
      coachId: [a, b],
      page: '3',
      limit: '10',
    });
    expect(memberModel.find).toHaveBeenCalledWith({ coachId: { $in: [a, b] } });
    expect(q.skip).toHaveBeenCalledWith(20);
    expect(res).toMatchObject({ page: 3, limit: 10, totalPages: 1 });
  });

  it('spans every tribe without a coachId', async () => {
    const { service, memberModel } = setup();
    await service.findAll({});
    expect(memberModel.find).toHaveBeenCalledWith({});
  });

  it('rejects a malformed tribe id', async () => {
    const { service } = setup();
    await expect(service.findAll({ coachId: 'zzz' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('searches name, phone, email, city and pincode with the input escaped', async () => {
    const { service, memberModel } = setup();
    await service.findAll({ search: '  (98.1+ ' });
    const filter = memberModel.find.mock.calls[0][0];
    expect(filter.$or.map((c: any) => Object.keys(c)[0])).toEqual([
      'name',
      'phone',
      'email',
      'addresses.city',
      'addresses.pincode',
    ]);
    const re: RegExp = filter.$or[0].name;
    expect(re.flags).toContain('i');
    expect(re.source).toBe('\\(98\\.1\\+');
    expect(re.test('x(98.1+y')).toBe(true);
    expect(re.test('(9861')).toBe(false);
  });
});

describe('TribeMembersService reads', () => {
  it('404s an unknown or malformed member', async () => {
    const { service, memberModel } = setup();
    await expect(service.findOne('bad')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    memberModel.findOne.mockReturnValue(query(null));
    await expect(service.findOne(String(MEMBER))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    memberModel.exists.mockResolvedValue(null);
    await expect(service.findOrders(String(MEMBER))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('scopes a read to one tribe when given (a TRIBE caller sees only its own)', async () => {
    const { service, memberModel } = setup();
    memberModel.findOne.mockReturnValue(query({ _id: MEMBER }));
    await service.findOne(String(MEMBER), String(TRIBE));
    expect(memberModel.findOne).toHaveBeenCalledWith({
      _id: String(MEMBER),
      coachId: String(TRIBE),
    });
    await service.findOrders(String(MEMBER), String(TRIBE));
    expect(memberModel.exists).toHaveBeenCalledWith({
      _id: String(MEMBER),
      coachId: String(TRIBE),
    });
    // Another tribe's member is simply not found.
    memberModel.findOne.mockReturnValue(query(null));
    await expect(
      service.findOne(String(MEMBER), String(new Types.ObjectId())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves a TRIBE user to the tribe it owns, 404 when it owns none', async () => {
    const { service, tribeModel } = setup();
    await expect(service.tribeIdForUser('u1')).resolves.toBe(String(TRIBE));
    expect(tribeModel.findOne).toHaveBeenCalledWith({ userId: 'u1' });
    tribeModel.findOne.mockReturnValue(query(null));
    await expect(service.tribeIdForUser('u2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a tribe whose admin has not enabled Tribe Members (off by default)', async () => {
    const { service, tribeModel } = setup();
    tribeModel.findOne.mockReturnValue(
      query({ _id: TRIBE, permissions: { members: false } }),
    );
    await expect(service.tribeIdForUser('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Never set at all → the default, which is off.
    tribeModel.findOne.mockReturnValue(query({ _id: TRIBE }));
    await expect(service.tribeIdForUser('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lists a member's orders as a plain array, deleted last, populated for the order dialog", async () => {
    const { service, orderModel } = setup();
    const q = query([{ _id: ORDER }]);
    orderModel.find.mockReturnValue(q);
    await expect(service.findOrders(String(MEMBER))).resolves.toEqual([
      { _id: ORDER },
    ]);
    expect(orderModel.find).toHaveBeenCalledWith({ memberId: String(MEMBER) });
    expect(q.sort).toHaveBeenCalledWith({ isDeleted: 1, createdAt: -1 });
    expect(q.populate).toHaveBeenCalledWith('items.productId');
    expect(q.populate).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'coachId' }),
    );
    expect(q.populate).toHaveBeenCalledWith(
      'campaignId',
      expect.stringContaining('name type'),
    );
  });
});
