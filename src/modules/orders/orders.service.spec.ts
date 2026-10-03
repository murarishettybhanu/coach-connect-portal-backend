import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { OrdersService, ALLOWED_TRANSITIONS } from './orders.service';
import {
  ApprovalStatus,
  OrderStatus,
  OrderType,
} from '../../schemas/order.schema';

/** A chainable stand-in for a Mongoose query that resolves to `value`. */
const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    populate: () => q,
    sort: () => q,
    lean: () => q,
  };
  return q;
};

const PRODUCT_ID = new Types.ObjectId().toString();
const ORDER_ID = new Types.ObjectId().toString();
const TRIBE_ID = new Types.ObjectId().toString();

const item = (extra: any = {}) => ({
  productId: PRODUCT_ID,
  quantity: 2,
  ...extra,
});

function setup() {
  const orderModel: any = jest.fn().mockImplementation((doc) => ({
    ...doc,
    _id: doc._id ?? new Types.ObjectId(),
    validate: jest.fn().mockResolvedValue(undefined),
    save: orderModel.save,
  }));
  orderModel.save = jest.fn();
  orderModel.findOne = jest.fn();
  orderModel.findOneAndUpdate = jest.fn();
  orderModel.findById = jest.fn();
  orderModel.find = jest.fn();
  orderModel.exists = jest.fn();
  orderModel.updateOne = jest.fn(() => query({}));
  orderModel.deleteOne = jest.fn(() => query({}));

  const campaignModel: any = {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const products = {
    findOne: jest.fn().mockResolvedValue({
      _id: PRODUCT_ID,
      coachId: TRIBE_ID,
      baseProductionCost: 100,
      retailPrice: 300,
    }),
    decrementStock: jest.fn().mockResolvedValue(undefined),
    incrementStock: jest.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    create: jest.fn().mockResolvedValue({}),
    reverseByOrder: jest.fn().mockResolvedValue(undefined),
  };
  const barcodes = {
    findByOrder: jest.fn().mockResolvedValue(null),
    assignToOrder: jest.fn().mockResolvedValue({ _id: 'bc1', code: 'EA123IN' }),
    releaseFromOrder: jest.fn().mockResolvedValue(undefined),
    releaseOne: jest.fn().mockResolvedValue(undefined),
  };
  const otp = { checkProof: jest.fn().mockReturnValue({ ok: true }) };
  const whatsapp = { canSend: false, sendTemplateByIdTo: jest.fn() };

  const service = new OrdersService(
    orderModel,
    campaignModel,
    products as any,
    transactions as any,
    barcodes as any,
    otp as any,
    whatsapp as any,
  );
  return {
    service,
    orderModel,
    campaignModel,
    products,
    transactions,
    barcodes,
    otp,
  };
}

const storeOrder = {
  shippingAddress: {
    fullName: 'Ravi',
    phone: '9876543210',
    addressLine1: '1 Road',
    city: 'Pune',
    state: 'MH',
    pincode: '411001',
  },
};

describe('OrdersService.create', () => {
  it('validates the address before any stock moves', async () => {
    const { service, products } = setup();
    await expect(
      service.create({
        items: [item()],
        shippingAddress: { fullName: 'Ravi', phone: '9876543210' },
      }),
    ).rejects.toThrow('Missing address fields');
    expect(products.decrementStock).not.toHaveBeenCalled();
  });

  it('restores stock when the save fails', async () => {
    const { service, orderModel, products } = setup();
    orderModel.save.mockRejectedValue(new Error('db down'));
    await expect(
      service.create({ ...storeOrder, items: [item()] }),
    ).rejects.toThrow('db down');
    expect(products.decrementStock).toHaveBeenCalledWith(
      PRODUCT_ID,
      2,
      undefined,
    );
    expect(products.incrementStock).toHaveBeenCalledWith(
      PRODUCT_ID,
      2,
      undefined,
    );
  });

  it('deletes the order and restores stock when the commission write fails', async () => {
    const { service, orderModel, products, transactions } = setup();
    orderModel.save.mockImplementation(function (this: any) {
      return Promise.resolve({ _id: new Types.ObjectId() });
    });
    transactions.create.mockRejectedValue(new Error('ledger down'));
    await expect(
      service.create({ ...storeOrder, items: [item()] }),
    ).rejects.toThrow('ledger down');
    expect(orderModel.deleteOne).toHaveBeenCalled();
    expect(products.incrementStock).toHaveBeenCalledTimes(1);
  });

  it('rejects a PHOTO value outside the upload bucket, before stock moves', async () => {
    const { service, products } = setup();
    const prev = { ...process.env };
    process.env.S3_PUBLIC_BASE_URL = 'https://media.example.com';
    try {
      await expect(
        service.create({
          ...storeOrder,
          items: [
            item({
              customizationType: 'PHOTO',
              customizationValue: 'http://169.254.169.254/latest',
            }),
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(products.decrementStock).not.toHaveBeenCalled();
    } finally {
      process.env = prev;
    }
  });
});

describe('OrdersService.deleteOrder / restoreOrder stock rules', () => {
  const preImage = (status: OrderStatus) => ({
    _id: ORDER_ID,
    status,
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
  });

  it.each([OrderStatus.NEW, OrderStatus.PACKED])(
    'restocks a %s order on delete',
    async (status) => {
      const { service, orderModel, products } = setup();
      orderModel.findOneAndUpdate.mockReturnValue(query(preImage(status)));
      await service.deleteOrder(ORDER_ID);
      expect(products.incrementStock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    OrderStatus.DISPATCHED,
    OrderStatus.DELIVERED,
    OrderStatus.RETURNED,
    OrderStatus.CANCELLED,
  ])('does not restock a %s order on delete', async (status) => {
    const { service, orderModel, products } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(query(preImage(status)));
    await service.deleteOrder(ORDER_ID);
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('reverses commission instead of deleting ledger rows', async () => {
    const { service, orderModel, transactions } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(
      query(preImage(OrderStatus.DELIVERED)),
    );
    await service.deleteOrder(ORDER_ID);
    expect(transactions.reverseByOrder).toHaveBeenCalledWith(
      ORDER_ID,
      'Order deleted',
    );
  });

  it('does nothing when the order is already deleted (lost the race)', async () => {
    const { service, orderModel, products, transactions } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(query(null));
    orderModel.exists.mockResolvedValue({ _id: ORDER_ID });
    await service.deleteOrder(ORDER_ID);
    expect(products.incrementStock).not.toHaveBeenCalled();
    expect(transactions.reverseByOrder).not.toHaveBeenCalled();
  });

  it.each([
    [OrderStatus.NEW, 1],
    [OrderStatus.RETURNED, 0],
    [OrderStatus.DISPATCHED, 0],
  ])('restore of a %s order takes stock %i time(s)', async (status, times) => {
    const { service, orderModel, products } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(
      query({ ...preImage(status), totalCommission: 0 }),
    );
    orderModel.findOne.mockReturnValue(query({ _id: ORDER_ID }));
    await service.restoreOrder(ORDER_ID);
    expect(products.decrementStock).toHaveBeenCalledTimes(times);
  });
});

describe('OrdersService approve / reject', () => {
  it('approves with an atomic PENDING precondition and records commission once', async () => {
    const { service, orderModel, transactions } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(
      query({
        _id: new Types.ObjectId(),
        coachId: TRIBE_ID,
        totalCommission: 50,
      }),
    );
    await service.approveOrder(ORDER_ID, 'admin');
    const [filter] = orderModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      approvalStatus: ApprovalStatus.PENDING,
      type: OrderType.WELCOME_KIT,
      isDeleted: { $ne: true },
    });
    expect(transactions.create).toHaveBeenCalledTimes(1);
  });

  it('a second approve finds nothing pending and records nothing', async () => {
    const { service, orderModel, transactions } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(query(null));
    orderModel.findOne.mockReturnValue(
      query({
        type: OrderType.WELCOME_KIT,
        approvalStatus: ApprovalStatus.APPROVED,
      }),
    );
    await expect(service.approveOrder(ORDER_ID, 'admin')).rejects.toThrow(
      'Order is not pending approval',
    );
    expect(transactions.create).not.toHaveBeenCalled();
  });

  it('reject restores stock only when its transition matched', async () => {
    const { service, orderModel, products } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(
      query({
        _id: ORDER_ID,
        status: OrderStatus.NEW,
        items: [{ productId: PRODUCT_ID, quantity: 3 }],
      }),
    );
    orderModel.findOne.mockReturnValue(query({ _id: ORDER_ID }));
    await service.rejectOrder(ORDER_ID, 'admin');
    expect(products.incrementStock).toHaveBeenCalledWith(
      PRODUCT_ID,
      3,
      undefined,
    );

    const second = setup();
    second.orderModel.findOneAndUpdate.mockReturnValue(query(null));
    second.orderModel.findOne.mockReturnValue(
      query({
        type: OrderType.WELCOME_KIT,
        approvalStatus: ApprovalStatus.REJECTED,
      }),
    );
    await expect(
      second.service.rejectOrder(ORDER_ID, 'admin'),
    ).rejects.toThrow();
    expect(second.products.incrementStock).not.toHaveBeenCalled();
  });
});

describe('OrdersService.updateStatus transitions', () => {
  const current = (status: OrderStatus, extra: any = {}) => ({
    _id: ORDER_ID,
    status,
    deliveryType: 'SPEED_POST',
    approvalStatus: null,
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
    ...extra,
  });

  it('allows the board’s forward moves', () => {
    expect(ALLOWED_TRANSITIONS.NEW).toEqual(
      expect.arrayContaining([OrderStatus.PACKED, OrderStatus.DISPATCHED]),
    );
    expect(ALLOWED_TRANSITIONS.PACKED).toContain(OrderStatus.DISPATCHED);
    expect(ALLOWED_TRANSITIONS.DISPATCHED).toContain(OrderStatus.DELIVERED);
  });

  it.each([
    [OrderStatus.DELIVERED, OrderStatus.NEW],
    [OrderStatus.DISPATCHED, OrderStatus.PACKED],
    [OrderStatus.CANCELLED, OrderStatus.NEW],
    [OrderStatus.NEW, OrderStatus.RETURNED],
    [OrderStatus.DISPATCHED, OrderStatus.CANCELLED],
  ])('refuses %s → %s', async (from, to) => {
    const { service, orderModel, barcodes } = setup();
    orderModel.findOne.mockReturnValue(query(current(from)));
    await expect(service.updateStatus(ORDER_ID, to)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(barcodes.assignToOrder).not.toHaveBeenCalled();
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not claim a barcode for a claim still pending approval', async () => {
    const { service, orderModel, barcodes } = setup();
    orderModel.findOne.mockReturnValue(
      query(
        current(OrderStatus.NEW, { approvalStatus: ApprovalStatus.PENDING }),
      ),
    );
    await expect(
      service.updateStatus(ORDER_ID, OrderStatus.PACKED),
    ).rejects.toThrow('Approve this claim');
    expect(barcodes.assignToOrder).not.toHaveBeenCalled();
  });

  it('packs conditionally on the status it validated against', async () => {
    const { service, orderModel } = setup();
    orderModel.findOne.mockReturnValue(query(current(OrderStatus.NEW)));
    orderModel.findOneAndUpdate.mockReturnValue(
      query(current(OrderStatus.PACKED)),
    );
    await service.updateStatus(ORDER_ID, OrderStatus.PACKED);
    const [filter, update] = orderModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ status: OrderStatus.NEW });
    expect(update.$set).toMatchObject({
      status: OrderStatus.PACKED,
      trackingNumber: 'EA123IN',
    });
  });

  it('gives back a freshly claimed barcode when it loses a race', async () => {
    const { service, orderModel, barcodes } = setup();
    orderModel.findOne.mockReturnValue(query(current(OrderStatus.NEW)));
    orderModel.findOneAndUpdate.mockReturnValue(query(null));
    await expect(
      service.updateStatus(ORDER_ID, OrderStatus.PACKED),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(barcodes.releaseOne).toHaveBeenCalledWith('bc1');
  });

  it('cancelling an order reverses its commission', async () => {
    const { service, orderModel, transactions } = setup();
    orderModel.findOne.mockReturnValue(query(current(OrderStatus.NEW)));
    orderModel.findOneAndUpdate.mockReturnValue(
      query(current(OrderStatus.CANCELLED)),
    );
    await service.updateStatus(ORDER_ID, OrderStatus.CANCELLED);
    expect(transactions.reverseByOrder).toHaveBeenCalledWith(
      ORDER_ID,
      'Order cancelled',
    );
  });

  it('cancelling a packed order restocks and frees the barcode', async () => {
    const { service, orderModel, products, barcodes } = setup();
    orderModel.findOne.mockReturnValue(query(current(OrderStatus.PACKED)));
    orderModel.findOneAndUpdate.mockReturnValue(
      query(current(OrderStatus.CANCELLED)),
    );
    await service.updateStatus(ORDER_ID, OrderStatus.CANCELLED);
    expect(products.incrementStock).toHaveBeenCalledTimes(1);
    expect(barcodes.releaseFromOrder).toHaveBeenCalledWith(ORDER_ID);
    const [, update] = orderModel.findOneAndUpdate.mock.calls[0];
    expect(update.$unset).toEqual({ trackingNumber: 1 });
  });
});

describe('OrdersService.markReturned', () => {
  it('restocks only when its atomic transition matched', async () => {
    const { service, orderModel, products } = setup();
    orderModel.findOneAndUpdate.mockReturnValue(query(null));
    orderModel.findOne.mockReturnValue(query({ status: OrderStatus.RETURNED }));
    await expect(service.markReturned('EA123IN')).rejects.toThrow(
      'already logged as returned',
    );
    expect(products.incrementStock).not.toHaveBeenCalled();
    const [filter] = orderModel.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({
      $in: [OrderStatus.DISPATCHED, OrderStatus.DELIVERED],
    });
  });
});

describe('OrdersService.findPendingClaim', () => {
  const CAMPAIGN = new Types.ObjectId().toString();

  it('hides the name without a valid proof token', async () => {
    const { service, orderModel } = setup();
    orderModel.find.mockReturnValue(
      query([{ shippingAddress: { fullName: 'Ravi' } }]),
    );
    const res = await service.findPendingClaim(CAMPAIGN, '9876543210');
    expect(res).toEqual({ found: true, count: 1 });
  });

  it('returns the name to a verified caller', async () => {
    const { service, orderModel, otp } = setup();
    orderModel.find.mockReturnValue(
      query([{ shippingAddress: { fullName: 'Ravi' } }]),
    );
    const res = await service.findPendingClaim(CAMPAIGN, '9876543210', 'tok');
    expect(otp.checkProof).toHaveBeenCalledWith('tok', '9876543210');
    expect(res).toEqual({ found: true, count: 1, fullName: 'Ravi' });
  });
});

describe('OrdersService.findAllPaginated tribe filter', () => {
  const run = async (coachId: any) => {
    const { service, orderModel } = setup();
    const page = { ...query([]), skip: () => page, limit: () => page };
    page.sort = () => page;
    page.populate = () => page;
    orderModel.find.mockReturnValue(page);
    orderModel.countDocuments = jest.fn(() => query(0));
    await service.findAllPaginated({ coachId });
    return orderModel.find.mock.calls[0][0];
  };

  it('narrows to every tribe in a comma-separated list', async () => {
    const other = new Types.ObjectId().toString();
    const filter = await run(`${TRIBE_ID}, ${other}`);
    expect(filter.coachId).toEqual({ $in: [TRIBE_ID, other] });
  });

  it('still accepts a single tribe id', async () => {
    expect((await run(TRIBE_ID)).coachId).toEqual({ $in: [TRIBE_ID] });
  });

  it('spans all tribes when none are given', async () => {
    expect((await run(undefined)).coachId).toBeUndefined();
  });

  it('rejects a malformed id instead of matching nothing', async () => {
    await expect(run(`${TRIBE_ID},nope`)).rejects.toBeInstanceOf(BadRequestException);
  });
});
