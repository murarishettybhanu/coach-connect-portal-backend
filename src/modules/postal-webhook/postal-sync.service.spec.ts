import { Types } from 'mongoose';
import { PostalSyncService } from './postal-sync.service';

const query = (v: unknown) => {
  const q: any = {
    select: () => q,
    limit: () => q,
    lean: () => q,
    exec: jest.fn().mockResolvedValue(v),
  };
  return q;
};

const result = (n: string, over: any = {}) => ({
  consignmentNumber: n,
  available: true,
  found: true,
  partial: false,
  currentStatus: 'Item Booked',
  currentStatusType: 'ItemBooked',
  delivered: false,
  bookedAt: '2026-10-10T05:00:00Z',
  deliveredAt: null,
  lastUpdatedAt: '2026-10-10T05:00:00Z',
  events: [
    {
      timestamp: '2026-10-10T05:00:00Z',
      event: 'Item Booked',
      eventType: 'ItemBooked',
      office: 'Pune HO',
      pincode: '411001',
      remarks: '',
      rts: false,
    },
  ],
  returnToSender: false,
  source: 'India Post',
  fetchedAt: '',
  ...over,
});

function setup(orders: any[], results: any[] | Error) {
  const orderModel = { find: jest.fn(() => query(orders)) };
  const tracking = {
    trackMany: jest.fn(async (nums: string[]) => {
      if (results instanceof Error) throw results;
      return results.filter((r: any) => nums.includes(r.consignmentNumber));
    }),
  };
  const webhook = {
    storeScan: jest.fn().mockResolvedValue(true),
    recordLatestScan: jest.fn().mockResolvedValue(undefined),
    applyMilestone: jest.fn(async (o: any, m: string, ..._rest: any[]) =>
      m === 'BOOKED' && o.status === 'PACKED'
        ? 'DISPATCHED'
        : m === 'DELIVERED'
          ? 'DELIVERED'
          : m === 'RETURNED'
            ? 'RETURN_FLAGGED'
            : null,
    ),
  };
  return {
    svc: new PostalSyncService(
      orderModel as any,
      tracking as any,
      webhook as any,
    ),
    orderModel,
    tracking,
    webhook,
  };
}
const order = (status: string, tn: string) => ({
  _id: new Types.ObjectId(),
  status,
  trackingNumber: tn,
  shippingAddress: { fullName: 'Asha' },
});

describe('PostalSyncService.milestoneFor', () => {
  it('returned beats delivered; delivered; otherwise booked; unknown → null', () => {
    expect(
      PostalSyncService.milestoneFor(result('X', { found: false }) as any),
    ).toBeNull();
    expect(PostalSyncService.milestoneFor(result('X') as any)).toBe('BOOKED');
    expect(
      PostalSyncService.milestoneFor(result('X', { delivered: true }) as any),
    ).toBe('DELIVERED');
    expect(
      PostalSyncService.milestoneFor(
        result('X', { delivered: true, returnToSender: true }) as any,
      ),
    ).toBe('RETURNED');
    expect(
      PostalSyncService.milestoneFor(
        result('X', {
          events: [
            {
              timestamp: '2026-10-11T00:00:00Z',
              event: 'Item Returned',
              eventType: '',
              office: '',
              pincode: '',
              remarks: '',
              rts: false,
            },
          ],
        }) as any,
      ),
    ).toBe('RETURNED');
  });
});

describe('PostalSyncService.sync', () => {
  it('only queries Ready to Ship / Dispatched, approved, with a tracking number, in the filter scope', async () => {
    const { svc, orderModel } = setup([], []);
    const coach = new Types.ObjectId().toString();
    await svc.sync({ coachId: coach });
    const f = (orderModel.find.mock.calls[0] as any)[0];
    expect(f.status).toEqual({ $in: ['PACKED', 'DISPATCHED'] });
    expect(f.approvalStatus).toEqual({ $nin: ['PENDING', 'REJECTED'] });
    expect(f.coachId).toEqual({ $in: [coach] });
    expect(f.isDeleted).toEqual({ $ne: true });
  });

  it('dispatches booked Ready-to-Ship orders, delivers delivered ones, flags returns, counts the rest', async () => {
    const a = order('PACKED', 'ea100000001in');
    const b = order('DISPATCHED', 'EA100000002IN');
    const c = order('DISPATCHED', 'EA100000003IN');
    const d = order('DISPATCHED', 'EA100000004IN');
    const e = order('PACKED', 'EA100000005IN');
    const bad = order('PACKED', 'not-a-number');
    const { svc, webhook } = setup(
      [a, b, c, d, e, bad],
      [
        result('EA100000001IN'),
        result('EA100000002IN', {
          delivered: true,
          currentStatus: 'Item Delivered',
          deliveredAt: '2026-10-12T06:00:00Z',
        }),
        result('EA100000003IN', {
          returnToSender: true,
          currentStatus: 'Item Returned',
        }),
        result('EA100000004IN'),
        result('EA100000005IN', { found: false }),
      ],
    );
    const s = await svc.sync();
    expect(s).toMatchObject({
      checked: 5,
      dispatched: 1,
      delivered: 1,
      returnsFlagged: 1,
      unchanged: 1,
      notFound: 1,
      failed: 1,
    });
    expect(s.changes.map((x) => [x.trackingNumber, x.change])).toEqual([
      ['EA100000001IN', 'DISPATCHED'],
      ['EA100000002IN', 'DELIVERED'],
      ['EA100000003IN', 'RETURN_FLAGGED'],
    ]);
    // Latest scan recorded and scans stored for every order India Post knows.
    expect(webhook.recordLatestScan).toHaveBeenCalledTimes(4);
    expect(webhook.storeScan).toHaveBeenCalledTimes(4);
    expect(webhook.applyMilestone.mock.calls[1][2]).toEqual(
      new Date('2026-10-12T06:00:00Z'),
    );
  });

  it("doesn't re-store scans that came from the webhook fallback", async () => {
    const { svc, webhook } = setup(
      [order('PACKED', 'EA100000001IN')],
      [result('EA100000001IN', { source: 'India Post (webhook)' })],
    );
    await svc.sync();
    expect(webhook.storeScan).not.toHaveBeenCalled();
  });

  it('batches by 500 and reports a failed batch without touching orders', async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      order('DISPATCHED', `EA${String(100000000 + i)}IN`),
    );
    const ok = setup(
      many,
      many.map((o) => result(o.trackingNumber)),
    );
    await ok.svc.sync();
    expect(ok.tracking.trackMany).toHaveBeenCalledTimes(2);
    expect((ok.tracking.trackMany.mock.calls[0] as any)[0]).toHaveLength(500);

    const failing = setup(
      [order('PACKED', 'EA100000001IN')],
      new Error("India Post hasn't enabled this API"),
    );
    const s = await failing.svc.sync();
    expect(s.errors).toEqual(["India Post hasn't enabled this API"]);
    expect(s.failed).toBe(1);
    expect(failing.webhook.applyMilestone).not.toHaveBeenCalled();
  });
});
