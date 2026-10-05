import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Types } from 'mongoose';
import { RestockService } from './restock.service';
import {
  AdminRestockController,
  RestockController,
} from './restock.controller';
import { CreateRestockRequestDto } from './dto/restock.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../schemas/user.schema';
import { RestockStatus } from '../../schemas/restock-request.schema';

// A chainable stand-in for a Mongoose query.
const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
    populate: () => q,
  };
  return q;
};

const oid = () => new Types.ObjectId();
const TRIBE = String(oid());
const NOW = new Date('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const dispatched = (d: number) => [
  { status: 'NEW', at: daysAgo(d + 1) },
  { status: 'DISPATCHED', at: daysAgo(d) },
];

function setup(opts: {
  products?: any[];
  kits?: any[];
  orders?: any[];
  campaigns?: any[];
  pending?: any;
}) {
  const models = {
    restock: {
      findOne: jest.fn(() => query(opts.pending ?? null)),
      find: jest.fn(() => query([])),
      create: jest.fn(async (doc: any) => ({ _id: oid(), ...doc })),
      countDocuments: jest.fn(() => query(0)),
      findById: jest.fn(() => query(null)),
      findOneAndUpdate: jest.fn(() => query(null)),
      findByIdAndUpdate: jest.fn(() => query(null)),
    } as any,
    order: { find: jest.fn(() => query(opts.orders ?? [])) } as any,
    campaign: { find: jest.fn(() => query(opts.campaigns ?? [])) } as any,
    product: { find: jest.fn(() => query(opts.products ?? [])) } as any,
    kit: { find: jest.fn(() => query(opts.kits ?? [])) } as any,
    tribe: { findOne: jest.fn(() => query({ _id: TRIBE })) } as any,
  };
  const service = new RestockService(
    models.restock,
    models.order,
    models.campaign,
    models.product,
    models.kit,
    models.tribe,
  );
  return { models, service };
}

describe('RestockService.overview', () => {
  const tee = { _id: oid(), name: 'Tee', stockLevel: 25 };
  const mug = { _id: oid(), name: 'Mug', stockLevel: -3, imageUrl: 'm.png' };
  const cap = { _id: oid(), name: 'Cap', stockLevel: 500 };
  const kit = {
    _id: oid(),
    name: 'Diamond Kit',
    items: [
      { productId: tee, quantity: 1 },
      { productId: cap, quantity: 2 },
    ],
  };
  const kitCampaign = { _id: oid(), kitId: kit._id };

  function scenario() {
    return setup({
      products: [tee, mug, cap],
      kits: [kit],
      campaigns: [kitCampaign],
      orders: [
        // This week: 2 kit claims (Tee + 2 Cap each)…
        ...[1, 2].map((d) => ({
          campaignId: kitCampaign._id,
          statusHistory: dispatched(d),
          items: [
            { productId: tee._id, quantity: 1 },
            { productId: cap._id, quantity: 2 },
          ],
        })),
        // …and a store order of 3 tees, with a mug line unticked at approval.
        {
          statusHistory: dispatched(3),
          items: [
            { productId: tee._id, quantity: 3 },
            { productId: mug._id, quantity: 4, selected: false },
          ],
        },
        // Two weeks ago: 4 mugs (pace only).
        {
          statusHistory: dispatched(14),
          items: [{ productId: mug._id, quantity: 4 }],
        },
      ],
    });
  }

  it('queries dispatches once over the 28-day window for the caller’s tribe', async () => {
    const { models, service } = scenario();
    await service.overview(TRIBE, NOW);
    expect(models.order.find).toHaveBeenCalledTimes(1);
    const [filter] = models.order.find.mock.calls[0];
    expect(filter.coachId).toBe(TRIBE);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.statusHistory.$elemMatch.status).toBe('DISPATCHED');
    expect(filter.statusHistory.$elemMatch.at.$gte).toEqual(daysAgo(28));
    expect(models.campaign.find).toHaveBeenCalledTimes(1);
    expect(models.campaign.find.mock.calls[0][0]).toEqual({
      coachId: TRIBE,
      kitId: { $ne: null },
    });
    expect(models.product.find.mock.calls[0][0]).toEqual({
      coachId: TRIBE,
      isDeleted: { $ne: true },
    });
    expect(models.kit.find.mock.calls[0][0]).toEqual({
      coachId: TRIBE,
      isDeleted: { $ne: true },
    });
  });

  it('assembles items, totals, counts and the highlight', async () => {
    const { service } = scenario();
    const res = await service.overview(TRIBE, NOW);

    expect(res.generatedAt).toBe(NOW.toISOString());
    expect(res.windowDays).toBe(7);
    // 1+2 + 1+2 + 3 units (the unticked mug line doesn't count), 3 orders.
    expect(res.totals).toEqual({
      shippedThisWeek: 9,
      ordersShippedThisWeek: 3,
    });

    const by = Object.fromEntries(res.items.map((i) => [i.name, i]));
    expect(by['Diamond Kit']).toMatchObject({
      kind: 'KIT',
      id: String(kit._id),
      stock: 25, // min(25/1, 500/2)
      shippedThisWeek: 2,
      weeklyPace: 2,
      level: 'HEALTHY',
    });
    expect(by['Tee']).toMatchObject({
      kind: 'PRODUCT',
      stock: 25,
      shippedThisWeek: 5,
      weeklyPace: 5,
      daysLeft: 35,
      lowAt: 10,
      criticalAt: 5,
      level: 'HEALTHY',
    });
    expect(by['Mug']).toMatchObject({
      stock: -3,
      shippedThisWeek: 0,
      weeklyPace: 1,
      daysLeft: 0,
      level: 'OUT',
      suggestedQty: 23, // 2 × 10 + 3 short
      imageUrl: 'm.png',
    });
    expect(by['Cap']).toMatchObject({ shippedThisWeek: 4, level: 'HEALTHY' });
    expect(by['Cap'].imageUrl).toBeUndefined();

    expect(res.counts).toEqual({ OUT: 1, CRITICAL: 0, LOW: 0, HEALTHY: 3 });
    // A kit shipped this week, so it wins over the busier Tee.
    expect(res.highlight).toEqual({
      kind: 'KIT',
      id: String(kit._id),
      name: 'Diamond Kit',
      shippedThisWeek: 2,
      stock: 25,
      level: 'HEALTHY',
    });
    expect(res.pendingRequest).toBeNull();
  });

  it('sorts by severity, then days left (null last), then name', async () => {
    const { service } = setup({
      products: [
        { _id: oid(), name: 'Idle', stockLevel: 3 }, // CRITICAL, null days
        { _id: oid(), name: 'Healthy', stockLevel: 100 },
        { _id: oid(), name: 'Gone', stockLevel: 0 },
        { _id: oid(), name: 'Short', stockLevel: -2 },
        { _id: oid(), name: 'Low', stockLevel: 8 },
      ],
    });
    const items = (await service.overview(TRIBE, NOW)).items;
    expect(items.map((i) => `${i.level}:${i.name}`)).toEqual([
      'OUT:Gone',
      'OUT:Short',
      'CRITICAL:Idle',
      'LOW:Low',
      'HEALTHY:Healthy',
    ]);
  });

  it('highlights the top product when no kit shipped, null when nothing did', async () => {
    const a = { _id: oid(), name: 'A', stockLevel: 40 };
    const b = { _id: oid(), name: 'B', stockLevel: 40 };
    const shipped = setup({
      products: [a, b],
      kits: [{ _id: oid(), name: 'K', items: [{ productId: a, quantity: 1 }] }],
      orders: [
        {
          statusHistory: dispatched(1),
          items: [{ productId: b._id, quantity: 6 }],
        },
        {
          statusHistory: dispatched(2),
          items: [{ productId: a._id, quantity: 2 }],
        },
      ],
    });
    const res = await shipped.service.overview(TRIBE, NOW);
    expect(res.highlight).toMatchObject({
      kind: 'PRODUCT',
      name: 'B',
      shippedThisWeek: 6,
    });

    const idle = setup({ products: [a], orders: [] });
    const quiet = await idle.service.overview(TRIBE, NOW);
    expect(quiet.highlight).toBeNull();
    expect(quiet.totals).toEqual({
      shippedThisWeek: 0,
      ordersShippedThisWeek: 0,
    });
    expect(quiet.items[0].daysLeft).toBeNull();
  });

  it('a dispatch older than 7 days counts towards the pace only', async () => {
    const p = { _id: oid(), name: 'P', stockLevel: 30 };
    const { service } = setup({
      products: [p],
      orders: [
        {
          statusHistory: dispatched(10),
          items: [{ productId: p._id, quantity: 20 }],
        },
      ],
    });
    const [item] = (await service.overview(TRIBE, NOW)).items;
    expect(item.shippedThisWeek).toBe(0);
    expect(item.weeklyPace).toBe(5);
    expect(item.daysLeft).toBe(42);
  });

  it('returns the latest open request as pendingRequest', async () => {
    const pending = { _id: oid(), status: RestockStatus.CONFIRMED };
    const { models, service } = setup({ pending });
    const res = await service.overview(TRIBE, NOW);
    expect(res.pendingRequest).toBe(pending);
    expect(models.restock.findOne.mock.calls[0][0]).toEqual({
      coachId: TRIBE,
      status: {
        $in: [
          RestockStatus.NEW,
          RestockStatus.CONFIRMED,
          RestockStatus.IN_PRODUCTION,
        ],
      },
    });
  });
});

describe('RestockService.createRequest', () => {
  const tee = { _id: oid(), name: 'Tee', stockLevel: -4 };
  const kit = {
    _id: oid(),
    name: 'Starter Kit',
    items: [{ productId: { _id: tee._id, stockLevel: 9 }, quantity: 2 }],
  };

  it('snapshots name and stock, and stores the tribe from the session', async () => {
    const { models, service } = setup({ products: [tee], kits: [kit] });
    await service.createRequest(TRIBE, {
      items: [
        { kind: 'PRODUCT', id: String(tee._id), quantity: 30 },
        { kind: 'KIT', id: String(kit._id), quantity: 10 },
      ] as any,
      note: '  before Diwali ',
      neededBy: '2026-10-20',
    });
    const [doc] = models.restock.create.mock.calls[0];
    expect(doc).toEqual({
      coachId: TRIBE,
      items: [
        {
          kind: 'PRODUCT',
          refId: tee._id,
          name: 'Tee',
          quantity: 30,
          stockAtRequest: -4,
        },
        {
          kind: 'KIT',
          refId: kit._id,
          name: 'Starter Kit',
          quantity: 10,
          stockAtRequest: 4,
        },
      ],
      note: 'before Diwali',
      neededBy: new Date('2026-10-20'),
      status: RestockStatus.NEW,
    });
    // Ownership is part of the lookup.
    expect(models.product.find.mock.calls[0][0]).toMatchObject({
      coachId: TRIBE,
      isDeleted: { $ne: true },
    });
    expect(models.kit.find.mock.calls[0][0]).toMatchObject({
      coachId: TRIBE,
      isDeleted: { $ne: true },
    });
  });

  it('400s a product or kit that isn’t the caller’s own', async () => {
    // The lookups are scoped to the tribe, so a foreign id simply isn't found.
    const { models, service } = setup({ products: [], kits: [] });
    await expect(
      service.createRequest(TRIBE, {
        items: [{ kind: 'PRODUCT', id: String(oid()), quantity: 1 }] as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createRequest(TRIBE, {
        items: [{ kind: 'KIT', id: String(oid()), quantity: 1 }] as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(models.restock.create).not.toHaveBeenCalled();
  });

  it('400s the same item twice', async () => {
    const { service } = setup({ products: [tee] });
    const line = { kind: 'PRODUCT', id: String(tee._id), quantity: 1 };
    await expect(
      service.createRequest(TRIBE, { items: [line, line] as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CreateRestockRequestDto validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (body: any) =>
    pipe.transform(body, { type: 'body', metatype: CreateRestockRequestDto });
  const item = (over: any = {}) => ({
    kind: 'PRODUCT',
    id: String(oid()),
    quantity: 5,
    ...over,
  });

  it('accepts a valid request', async () => {
    await expect(
      validate({ items: [item()], note: 'x', neededBy: '2026-10-20' }),
    ).resolves.toBeInstanceOf(CreateRestockRequestDto);
    await expect(
      validate({
        items: [item({ quantity: 1 }), item({ kind: 'KIT', quantity: 100000 })],
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['no items', { items: [] }],
    ['too many items', { items: Array.from({ length: 101 }, () => item()) }],
    ['quantity 0', { items: [item({ quantity: 0 })] }],
    ['quantity above 100000', { items: [item({ quantity: 100001 })] }],
    ['fractional quantity', { items: [item({ quantity: 1.5 })] }],
    ['unknown kind', { items: [item({ kind: 'BOX' })] }],
    ['bad id', { items: [item({ id: 'nope' })] }],
    ['long note', { items: [item()], note: 'x'.repeat(1001) }],
    ['bad date', { items: [item()], neededBy: 'soon' }],
    ['extra field', { items: [item()], coachId: String(oid()) }],
  ])('rejects %s', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RestockService admin', () => {
  const ID = String(oid());

  it('unread = NEW and never opened; returns the newest few with item counts', async () => {
    const { models, service } = setup({});
    models.restock.countDocuments.mockReturnValue(query(2));
    const tribe = { _id: TRIBE, brand: 'FocusFwd' };
    models.restock.find.mockReturnValue(
      query([{ _id: ID, coachId: tribe, items: [{}, {}, {}], createdAt: NOW }]),
    );
    await expect(service.unread()).resolves.toEqual({
      count: 2,
      latest: [{ _id: ID, coachId: tribe, itemsCount: 3, createdAt: NOW }],
    });
    const unread = { status: RestockStatus.NEW, seenAt: { $exists: false } };
    expect(models.restock.countDocuments).toHaveBeenCalledWith(unread);
    expect(models.restock.find).toHaveBeenCalledWith(unread);
  });

  it('opening marks it seen once — the first open time is kept', async () => {
    const { models, service } = setup({});
    models.restock.findOneAndUpdate.mockReturnValue(query({ _id: ID }));
    await service.markSeen(ID);
    const [filter, update] = models.restock.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: ID, seenAt: { $exists: false } });
    expect(update.$set.seenAt).toBeInstanceOf(Date);

    models.restock.findOneAndUpdate.mockReturnValue(query(null));
    models.restock.findById.mockReturnValue(
      query({ _id: ID, seenAt: new Date(0) }),
    );
    await expect(service.markSeen(ID)).resolves.toMatchObject({ _id: ID });
  });

  it('an update also marks it seen, keeping an earlier first-seen time', async () => {
    const { models, service } = setup({});
    models.restock.findById.mockReturnValue(query({ _id: ID, status: 'NEW' }));
    models.restock.findByIdAndUpdate.mockReturnValue(query({ _id: ID }));
    await service.update(ID, {
      status: RestockStatus.CONFIRMED,
      adminNote: 'Ships Friday',
    });
    const [, first] = models.restock.findByIdAndUpdate.mock.calls[0];
    expect(first.$set.status).toBe(RestockStatus.CONFIRMED);
    expect(first.$set.adminNote).toBe('Ships Friday');
    expect(first.$set.seenAt).toBeInstanceOf(Date);

    models.restock.findById.mockReturnValue(
      query({ _id: ID, seenAt: new Date(0) }),
    );
    await service.update(ID, { status: RestockStatus.RECEIVED });
    expect(models.restock.findByIdAndUpdate.mock.calls[1][1].$set).toEqual({
      status: RestockStatus.RECEIVED,
    });
  });

  it('404s an unknown or malformed request', async () => {
    const { service } = setup({});
    await expect(service.markSeen('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.markSeen(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.update(ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('filters the list by status and tribe, newest first', async () => {
    const { models, service } = setup({});
    await service.list({ status: 'NEW', coachId: TRIBE });
    expect(models.restock.find).toHaveBeenCalledWith({
      status: 'NEW',
      coachId: TRIBE,
    });
    await service.list({});
    expect(models.restock.find).toHaveBeenLastCalledWith({});
    expect(() => service.list({ status: 'BOGUS' })).toThrow(
      BadRequestException,
    );
    expect(() => service.list({ coachId: 'x' })).toThrow(BadRequestException);
  });

  it('mine is the tribe’s own, newest 20', async () => {
    const { models, service } = setup({});
    const q = query([]);
    const limit = jest.spyOn(q, 'limit');
    models.restock.find.mockReturnValue(q);
    await service.mine(TRIBE);
    expect(models.restock.find).toHaveBeenCalledWith({ coachId: TRIBE });
    expect(limit).toHaveBeenCalledWith(20);
  });
});

describe('restock roles', () => {
  const allowed = (cls: any, handler: any, role: UserRole) =>
    new RolesGuard(new Reflector()).canActivate({
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as any);

  it.each([
    ['overview', RestockController.prototype.overview],
    ['create', RestockController.prototype.create],
    ['mine', RestockController.prototype.mine],
  ])('tribe %s is TRIBE only', (_n, handler) => {
    expect(allowed(RestockController, handler, UserRole.TRIBE)).toBe(true);
    expect(allowed(RestockController, handler, UserRole.ADMIN)).toBe(false);
    expect(allowed(RestockController, handler, UserRole.CUSTOMER)).toBe(false);
  });

  it.each([
    ['list', AdminRestockController.prototype.list],
    ['unread', AdminRestockController.prototype.unread],
    ['markSeen', AdminRestockController.prototype.markSeen],
    ['update', AdminRestockController.prototype.update],
  ])('admin %s is ADMIN only', (_n, handler) => {
    expect(allowed(AdminRestockController, handler, UserRole.ADMIN)).toBe(true);
    expect(allowed(AdminRestockController, handler, UserRole.TRIBE)).toBe(
      false,
    );
  });

  it('the tribe controller always uses the caller’s own tribe', async () => {
    const { models, service } = setup({});
    const spy = jest.spyOn(service, 'overview').mockResolvedValue({} as any);
    await new RestockController(service).overview('user-1');
    expect(models.tribe.findOne).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(spy).toHaveBeenCalledWith(TRIBE);
  });

  it('404s a TRIBE user without a tribe', async () => {
    const { models, service } = setup({});
    models.tribe.findOne.mockReturnValue(query(null));
    await expect(service.tribeIdForUser('u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
