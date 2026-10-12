import { Types } from 'mongoose';
import { ApprovalStatus, OrderStatus } from '../../schemas/order.schema';
import { PostalWebhookService } from './postal-webhook.service';

const query = (value: unknown) => {
  const q: any = {
    select: () => q,
    lean: () => q,
    sort: () => q,
    exec: jest.fn().mockResolvedValue(value),
  };
  return q;
};

const event = (code: string, description: string, extra: any = {}) => ({
  article_number: 'CA182468665IN',
  event_date: '2026-10-12',
  event_time: '10:00:00',
  event_code: code,
  event_description: description,
  event_office_name: 'Koramangala SO',
  event_office_facility_id: '21250001',
  ...extra,
});

function setup(orders: any[], opts: { duplicate?: boolean } = {}) {
  const eventModel = {
    exists: jest.fn(() => query(null)),
    create: jest.fn(async (..._args: any[]) => {
      if (opts.duplicate)
        throw Object.assign(new Error('dup'), { code: 11000 });
      return {};
    }),
  };
  const orderModel = {
    find: jest.fn(() => query(orders)),
    updateOne: jest.fn((..._args: any[]) => query({})),
  };
  const ordersService = { updateStatus: jest.fn().mockResolvedValue({}) };
  const service = new PostalWebhookService(
    eventModel as any,
    orderModel as any,
    ordersService as any,
  );
  return { service, eventModel, orderModel, ordersService };
}

const order = (status: OrderStatus, extra: any = {}) => ({
  _id: new Types.ObjectId(),
  status,
  approvalStatus: ApprovalStatus.APPROVED,
  ...extra,
});

describe('PostalWebhookService', () => {
  const env = process.env.INDIAPOST_WEBHOOK_TOKEN;
  afterAll(() => {
    process.env.INDIAPOST_WEBHOOK_TOKEN = env;
  });

  it('accepts only the configured token (disabled when unset or short)', () => {
    const { service } = setup([]);
    delete process.env.INDIAPOST_WEBHOOK_TOKEN;
    expect(service.tokenMatches('anything')).toBe(false);
    process.env.INDIAPOST_WEBHOOK_TOKEN = 'short';
    expect(service.tokenMatches('short')).toBe(false);
    process.env.INDIAPOST_WEBHOOK_TOKEN = 'a'.repeat(40);
    expect(service.tokenMatches('a'.repeat(40))).toBe(true);
    expect(service.tokenMatches('a'.repeat(39) + 'b')).toBe(false);
    expect(service.tokenMatches('')).toBe(false);
  });

  it('stores the event against the order and keeps its latest scan', async () => {
    const o = order(OrderStatus.DISPATCHED);
    const { service, eventModel, orderModel, ordersService } = setup([o]);
    const res = await service.ingest(event('BAG_CLOSE', 'Bag Close'), 'OTHER');
    expect(res).toEqual({ received: 1, stored: 1 });
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        articleNumber: 'CA182468665IN',
        orderId: o._id,
        channel: 'OTHER',
      }),
    );
    expect(
      orderModel.updateOne.mock.calls[0][1].$set.lastPostalEvent,
    ).toMatchObject({
      code: 'BAG_CLOSE',
      description: 'Bag Close',
      office: 'Koramangala SO',
    });
    expect(ordersService.updateStatus).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.NEW, OrderStatus.PACKED])(
    'Item Booked dispatches a %s order',
    async (s) => {
      const o = order(s);
      const { service, ordersService } = setup([o]);
      await service.ingest(event('ITEM_BOOK', 'Item Booked'), 'BOOKING');
      expect(ordersService.updateStatus).toHaveBeenCalledWith(
        String(o._id),
        OrderStatus.DISPATCHED,
      );
    },
  );

  it('Item Delivered delivers (skipping dispatch if needed)', async () => {
    const o = order(OrderStatus.PACKED);
    const { service, ordersService } = setup([o]);
    await service.ingest(event('ITEM_DELIVERY', 'Item Delivered'), 'OTHER');
    expect(ordersService.updateStatus).toHaveBeenCalledWith(
      String(o._id),
      OrderStatus.DELIVERED,
      undefined,
      undefined,
      { skipDispatch: true },
    );
  });

  it('does not move delivered, returned, cancelled or pending-approval orders', async () => {
    for (const o of [
      order(OrderStatus.DELIVERED),
      order(OrderStatus.RETURNED),
      order(OrderStatus.CANCELLED),
      order(OrderStatus.NEW, { approvalStatus: ApprovalStatus.PENDING }),
    ]) {
      const { service, ordersService } = setup([o]);
      await service.ingest(event('ITEM_DELIVERY', 'Item Delivered'), 'OTHER');
      await service.ingest(
        event('ITEM_BOOK', 'Item Booked', { event_time: '09:00:00' }),
        'BOOKING',
      );
      expect(ordersService.updateStatus).not.toHaveBeenCalled();
    }
  });

  it('Item Returned only flags the order', async () => {
    const o = order(OrderStatus.DISPATCHED);
    const { service, orderModel, ordersService } = setup([o]);
    await service.ingest(event('ITEM_RETURN', 'Item Returned'), 'OTHER');
    expect(ordersService.updateStatus).not.toHaveBeenCalled();
    const flag = orderModel.updateOne.mock.calls.find(
      (c: any) => c[1].$set.postalReturnReportedAt,
    );
    expect(flag).toBeTruthy();
  });

  it('a repeat of a stored scan does nothing', async () => {
    const { service, ordersService, orderModel } = setup(
      [order(OrderStatus.NEW)],
      { duplicate: true },
    );
    const res = await service.ingest(
      event('ITEM_BOOK', 'Item Booked'),
      'BOOKING',
    );
    expect(res).toEqual({ received: 1, stored: 0 });
    expect(ordersService.updateStatus).not.toHaveBeenCalled();
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('records but touches no order when the number is on several or none', async () => {
    for (const orders of [
      [order(OrderStatus.NEW), order(OrderStatus.NEW)],
      [],
    ]) {
      const { service, eventModel, ordersService } = setup(orders);
      const res = await service.ingest(
        event('ITEM_BOOK', 'Item Booked'),
        'BOOKING',
      );
      expect(res.stored).toBe(1);
      expect(eventModel.create.mock.calls[0][0].orderId).toBeUndefined();
      expect(ordersService.updateStatus).not.toHaveBeenCalled();
    }
  });

  it('a failing status change never fails the webhook', async () => {
    const { service, ordersService } = setup([order(OrderStatus.NEW)]);
    ordersService.updateStatus.mockRejectedValue(
      new Error('changed meanwhile'),
    );
    await expect(
      service.ingest(event('ITEM_BOOK', 'Item Booked'), 'BOOKING'),
    ).resolves.toEqual({ received: 1, stored: 1 });
  });

  it('ignores a test ping', async () => {
    const { service, eventModel } = setup([]);
    expect(await service.ingest({ test: true }, 'OTHER')).toEqual({
      received: 0,
      stored: 0,
    });
    expect(eventModel.create).not.toHaveBeenCalled();
  });
});
