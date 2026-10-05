import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { AnalyticsService, parseIds } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserRole } from '../../schemas/user.schema';

// A chainable stand-in for a Mongoose query.
const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    sort: () => q,
    lean: () => q,
    populate: () => q,
  };
  return q;
};

const oid = () => new Types.ObjectId();
const TRIBE = String(oid());
const NOW = new Date('2026-10-05T12:00:00Z');
/** 00:00 IST on an IST date, as $dateTrunc returns it. */
const ist = (date: string) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() - 5.5 * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const tee = { _id: oid(), name: 'Tee', stockLevel: 100 };
const mug = { _id: oid(), name: 'Mug', stockLevel: -2 };
const cap = { _id: oid(), name: 'Cap', stockLevel: 8 };
const kit = {
  _id: oid(),
  name: 'Kit',
  items: [{ productId: { _id: tee._id, stockLevel: 100 }, quantity: 1 }],
};
const kit2 = { _id: oid(), name: 'Another kit', items: [] };
const kitCampaign = { _id: oid(), kitId: kit._id };

function setup(agg: any = {}, paceOrders: any[] = []) {
  const models = {
    order: {
      find: jest.fn(() => query(paceOrders)),
      aggregate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([
          {
            created: [],
            eventBuckets: [],
            eventProducts: [],
            eventCampaigns: [],
            snapshot: [],
            ...agg,
          },
        ]),
      })),
    } as any,
    campaign: { find: jest.fn(() => query([kitCampaign])) } as any,
    product: { find: jest.fn(() => query([tee, mug, cap])) } as any,
    kit: { find: jest.fn(() => query([kit, kit2])) } as any,
    tribe: { findOne: jest.fn(() => query({ _id: TRIBE })) } as any,
  };
  const service = new AnalyticsService(
    models.order,
    models.campaign,
    models.product,
    models.kit,
    models.tribe,
  );
  return { models, service };
}

const ev = (k: string, date: string, n: number) => ({
  _id: { k, b: ist(date) },
  n,
});

describe('AnalyticsService.tribe', () => {
  const q = { from: '2026-10-01', to: '2026-10-05' };

  it('makes the same few round trips whatever the range', async () => {
    for (const range of [
      q,
      { from: '2025-09-01', to: '2026-10-05', granularity: 'day' },
    ]) {
      const { models, service } = setup();
      await service.tribe(TRIBE, range as any, NOW);
      expect(models.order.aggregate).toHaveBeenCalledTimes(1);
      expect(models.order.find).toHaveBeenCalledTimes(1); // 28-day pace
      expect(models.product.find).toHaveBeenCalledTimes(1);
      expect(models.kit.find).toHaveBeenCalledTimes(1);
      expect(models.campaign.find).toHaveBeenCalledTimes(1);
    }
  });

  it('scopes the aggregation to the tribe, non-deleted, buckets with $dateTrunc in IST', async () => {
    const { models, service } = setup();
    await service.tribe(TRIBE, { ...q, granularity: 'week' } as any, NOW);
    const pipeline = models.order.aggregate.mock.calls[0][0];
    const match = pipeline[0].$match;
    expect(String(match.coachId)).toBe(TRIBE);
    expect(match.isDeleted).toEqual({ $ne: true });
    const json = JSON.stringify(pipeline);
    expect(json).toContain('"timezone":"Asia/Kolkata"');
    expect(json).toContain('"startOfWeek":"monday"');
    expect(json).toContain('"unit":"week"');
    // Range is [00:00 IST on from, 00:00 IST after to).
    expect(match.$or[0].createdAt).toEqual({
      $gte: new Date('2026-09-30T18:30:00Z'),
      $lt: new Date('2026-10-05T18:30:00Z'),
    });
    // Rejected claims don't count as orders; unticked lines are dropped.
    expect(json).toContain('"approvalStatus":{"$ne":"REJECTED"}');
    expect(json).toContain('"$ne":["$$l.selected",false]');
  });

  it('assembles KPIs and a zero-filled trend from the buckets', async () => {
    const { service } = setup({
      created: [
        { _id: ist('2026-10-01'), n: 4 },
        { _id: ist('2026-10-05'), n: 2 },
      ],
      eventBuckets: [
        ev('dispatched', '2026-10-02', 3),
        ev('dispatched', '2026-10-05', 1),
        ev('delivered', '2026-10-04', 2),
        ev('returned', '2026-10-05', 1),
      ],
      snapshot: [{ inTransit: 7, pending: 5, pendingApproval: 2 }],
    });
    const res = await service.tribe(TRIBE, q as any, NOW);
    expect(res.range).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
      granularity: 'day',
      timezone: 'Asia/Kolkata',
    });
    expect(res.kpis).toEqual({
      totalOrders: 6,
      dispatched: 4,
      delivered: 2,
      returned: 1,
      returnRate: 0.25,
      inTransit: 7,
      pending: 5,
      pendingApproval: 2,
    });
    expect(res.trend).toEqual([
      {
        bucket: '2026-10-01',
        label: '01 Oct',
        orders: 4,
        dispatched: 0,
        delivered: 0,
        returned: 0,
      },
      {
        bucket: '2026-10-02',
        label: '02 Oct',
        orders: 0,
        dispatched: 3,
        delivered: 0,
        returned: 0,
      },
      {
        bucket: '2026-10-03',
        label: '03 Oct',
        orders: 0,
        dispatched: 0,
        delivered: 0,
        returned: 0,
      },
      {
        bucket: '2026-10-04',
        label: '04 Oct',
        orders: 0,
        dispatched: 0,
        delivered: 2,
        returned: 0,
      },
      {
        bucket: '2026-10-05',
        label: '05 Oct',
        orders: 2,
        dispatched: 1,
        delivered: 0,
        returned: 1,
      },
    ]);
  });

  it('returns 0 rates and an all-zero trend with no data', async () => {
    const { service } = setup();
    const res = await service.tribe(TRIBE, {} as any, NOW);
    expect(res.trend).toHaveLength(30);
    expect(res.trend.every((t) => !t.orders && !t.dispatched)).toBe(true);
    expect(res.kpis.returnRate).toBe(0);
    expect(res.items.every((i) => i.returnRate === 0)).toBe(true);
  });

  it('builds per-item units, return rates, stock and levels; kits first then by dispatched', async () => {
    const { service } = setup(
      {
        eventProducts: [
          { _id: { k: 'dispatched', p: tee._id }, units: 3 },
          { _id: { k: 'returned', p: tee._id }, units: 1 },
          { _id: { k: 'delivered', p: tee._id }, units: 2 },
          { _id: { k: 'dispatched', p: cap._id }, units: 9 },
        ],
        eventCampaigns: [
          { _id: { k: 'dispatched', c: kitCampaign._id }, n: 2 },
          { _id: { k: 'delivered', c: kitCampaign._id }, n: 1 },
          // A campaign without a kit adds nothing to kits.
          { _id: { k: 'dispatched', c: oid() }, n: 5 },
        ],
      },
      // Pace (now): 7 caps dispatched this week → pace 7 → criticalAt 7, lowAt 14.
      [
        {
          statusHistory: [{ status: 'DISPATCHED', at: daysAgo(1) }],
          items: [{ productId: cap._id, quantity: 7 }],
        },
      ],
    );
    const res = await service.tribe(TRIBE, q as any, NOW);
    expect(res.items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'KIT:Kit',
      'KIT:Another kit',
      'PRODUCT:Cap',
      'PRODUCT:Tee',
      'PRODUCT:Mug',
    ]);
    const [k, k2, c, t, m] = res.items;
    expect(k).toEqual({
      kind: 'KIT',
      id: String(kit._id),
      name: 'Kit',
      dispatchedUnits: 2,
      deliveredUnits: 1,
      returnedUnits: 0,
      returnRate: 0,
      stock: 100,
      consumedUnits: 2,
      level: 'HEALTHY',
      daysLeft: null,
    });
    expect(k2).toMatchObject({ stock: 0, level: 'OUT', daysLeft: 0 });
    expect(t).toMatchObject({
      dispatchedUnits: 3,
      deliveredUnits: 2,
      returnedUnits: 1,
      returnRate: 0.3333,
      consumedUnits: 3,
      stock: 100,
    });
    // 8 caps at 7/week: LOW (> criticalAt 7, ≤ lowAt 14), 8 days left.
    expect(c).toMatchObject({ stock: 8, level: 'LOW', daysLeft: 8 });
    expect(m).toMatchObject({ stock: -2, level: 'OUT', daysLeft: 0 });
    expect(res.stockAlerts).toEqual({ OUT: 2, CRITICAL: 0, LOW: 1 });
  });

  it('breaks dispatched ties by name', async () => {
    const { service } = setup();
    const res = await service.tribe(TRIBE, q as any, NOW);
    expect(
      res.items.filter((i) => i.kind === 'PRODUCT').map((i) => i.name),
    ).toEqual(['Cap', 'Mug', 'Tee']);
  });

  describe('filters', () => {
    it('limits orders to the products OR the kits’ campaigns, and items to the selection', async () => {
      const { models, service } = setup();
      const res = await service.tribe(
        TRIBE,
        {
          ...q,
          productIds: `${tee._id}, ${tee._id}`,
          kitIds: String(kit._id),
        } as any,
        NOW,
      );
      const match = models.order.aggregate.mock.calls[0][0][0].$match;
      const [, filter] = match.$and;
      expect(filter.$or).toHaveLength(2);
      expect(filter.$or[0].items.$elemMatch.productId.$in.map(String)).toEqual([
        String(tee._id),
      ]);
      expect(filter.$or[0].items.$elemMatch.selected).toEqual({ $ne: false });
      expect(filter.$or[1].campaignId.$in.map(String)).toEqual([
        String(kitCampaign._id),
      ]);
      expect(res.items.map((i) => i.name)).toEqual(['Kit', 'Tee']);
    });

    it('products only → no kit rows; no filter → no extra match', async () => {
      const a = setup();
      const res = await a.service.tribe(
        TRIBE,
        { productIds: String(cap._id) } as any,
        NOW,
      );
      expect(res.items.map((i) => i.name)).toEqual(['Cap']);
      const b = setup();
      await b.service.tribe(TRIBE, { productIds: '' } as any, NOW);
      expect(
        b.models.order.aggregate.mock.calls[0][0][0].$match.$and,
      ).toBeUndefined();
    });

    it.each([
      ['another tribe’s product', { productIds: String(oid()) }],
      ['another tribe’s kit', { kitIds: String(oid()) }],
      ['a kit id passed as a product', { productIds: String(kit._id) }],
      ['a malformed id', { productIds: 'abc' }],
    ])('400 on %s, before any order query', async (_label, f) => {
      const { models, service } = setup();
      await expect(service.tribe(TRIBE, f as any, NOW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(models.order.aggregate).not.toHaveBeenCalled();
    });
  });

  it('400 on a bad range without touching the database', async () => {
    const { models, service } = setup();
    await expect(
      service.tribe(
        TRIBE,
        { from: '2026-10-05', to: '2026-10-01' } as any,
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(models.product.find).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.tribeIdForUser (Analytics permission)', () => {
  it('is refused until an admin enables Analytics (off by default)', async () => {
    const { models, service } = setup();
    // Never set → default off.
    await expect(service.tribeIdForUser('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    models.tribe.findOne.mockReturnValue(
      query({ _id: TRIBE, permissions: { analytics: false } }),
    );
    await expect(service.tribeIdForUser('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('resolves the tribe once enabled, 404 when the account has none', async () => {
    const { models, service } = setup();
    models.tribe.findOne.mockReturnValue(
      query({ _id: TRIBE, permissions: { analytics: true } }),
    );
    await expect(service.tribeIdForUser('u1')).resolves.toBe(String(TRIBE));
    models.tribe.findOne.mockReturnValue(query(null));
    await expect(service.tribeIdForUser('u2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('parseIds', () => {
  it('splits, trims, dedupes; empty → undefined', () => {
    const a = String(oid());
    expect(parseIds(undefined, 'x')).toBeUndefined();
    expect(parseIds(' , ', 'x')).toBeUndefined();
    expect(parseIds(`${a}, ${a},`, 'x')).toEqual([a]);
    expect(() => parseIds(`${a},{"$gt":""}`, 'x')).toThrow(BadRequestException);
  });
});

describe('AnalyticsController', () => {
  it('is TRIBE only, behind JWT + roles guards', () => {
    expect(Reflect.getMetadata('__guards__', AnalyticsController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    const roles = new Reflector().get('roles', AnalyticsController);
    expect(roles).toEqual([UserRole.TRIBE]);
    const guard = new RolesGuard(new Reflector());
    const ctx = (role: string) =>
      ({
        getHandler: () => AnalyticsController.prototype.tribe,
        getClass: () => AnalyticsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as any;
    expect(guard.canActivate(ctx(UserRole.TRIBE))).toBe(true);
    expect(guard.canActivate(ctx(UserRole.ADMIN))).toBe(false);
  });

  it('uses the caller’s own tribe', async () => {
    const svc = {
      tribeIdForUser: jest.fn().mockResolvedValue(TRIBE),
      tribe: jest.fn().mockResolvedValue('ok'),
    } as any;
    const c = new AnalyticsController(svc);
    await c.tribe('user-1', { from: '2026-10-01' });
    expect(svc.tribeIdForUser).toHaveBeenCalledWith('user-1');
    expect(svc.tribe).toHaveBeenCalledWith(TRIBE, { from: '2026-10-01' });
  });
});

describe('AnalyticsQueryDto validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (value: any) =>
    pipe.transform(value, { type: 'query', metatype: AnalyticsQueryDto });

  it('accepts the contract’s params', async () => {
    await expect(
      validate({
        from: '2026-10-01',
        to: '2026-10-05',
        granularity: 'week',
        productIds: 'a,b',
        kitIds: 'c',
      }),
    ).resolves.toBeInstanceOf(AnalyticsQueryDto);
  });

  it.each([
    ['bad date', { from: '1 Oct' }],
    ['bad granularity', { granularity: 'year' }],
    ['unknown param', { coachId: 'x' }],
  ])('rejects %s', async (_label, value) => {
    await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
