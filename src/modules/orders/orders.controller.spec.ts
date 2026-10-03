import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrdersController } from './orders.controller';
import {
  CreateOrderDto,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_ITEMS,
} from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-status.dto';
import { DownloadMediaDto, MAX_MEDIA_ORDERS } from './dto/download-media.dto';
import { UserRole } from '../../schemas/user.schema';

const USER_ID = new Types.ObjectId().toString();
const TRIBE_ID = new Types.ObjectId().toString();
const OTHER_TRIBE = new Types.ObjectId().toString();
const CAMPAIGN_ID = new Types.ObjectId().toString();
const ORDER_ID = new Types.ObjectId().toString();

function setup(
  opts: { payload?: any; user?: any; ownsCampaign?: boolean } = {},
) {
  const ordersService = {
    create: jest.fn().mockResolvedValue({}),
    attachAddressByPhone: jest.fn().mockResolvedValue({ updated: 1 }),
    isCampaignOwnedBy: jest.fn().mockResolvedValue(opts.ownsCampaign ?? false),
    findOne: jest
      .fn()
      .mockResolvedValue({ _id: ORDER_ID, coachId: { _id: OTHER_TRIBE } }),
    approveOrder: jest.fn().mockResolvedValue({}),
    rejectOrder: jest.fn().mockResolvedValue({}),
    updateAddress: jest.fn().mockResolvedValue({}),
  };
  const tribesService = {
    findIdByUserId: jest.fn().mockResolvedValue(TRIBE_ID),
  };
  const usersService = {
    findOneById: jest.fn().mockResolvedValue(opts.user ?? null),
  };
  const jwtService = {
    verify: jest.fn(() => {
      if (!opts.payload) throw new Error('invalid');
      return opts.payload;
    }),
  };
  const controller = new OrdersController(
    ordersService as any,
    tribesService as any,
    usersService as any,
    jwtService as any,
  );
  return { controller, ordersService, usersService, tribesService };
}

const bearer = { headers: { authorization: 'Bearer abc' } };
const claim = { campaignId: CAMPAIGN_ID, items: [] } as any;

describe('OrdersController trust on public writes', () => {
  it('no token → untrusted', async () => {
    const { controller, ordersService } = setup();
    await controller.create(claim, { headers: {} });
    expect(ordersService.create).toHaveBeenCalledWith(claim, {
      trusted: false,
    });
  });

  it('a WhatsApp OTP proof token (same secret) → untrusted', async () => {
    const { controller, ordersService, usersService } = setup({
      payload: { sub: '919876543210', purpose: 'whatsapp-otp' },
    });
    await controller.create(claim, bearer);
    expect(usersService.findOneById).not.toHaveBeenCalled();
    expect(ordersService.create).toHaveBeenCalledWith(claim, {
      trusted: false,
    });
  });

  it('a valid token for a user that no longer exists → untrusted', async () => {
    const { controller, ordersService } = setup({ payload: { sub: USER_ID } });
    await controller.create(claim, bearer);
    expect(ordersService.create).toHaveBeenCalledWith(claim, {
      trusted: false,
    });
  });

  it('a session retired by a password change → untrusted', async () => {
    const { controller, ordersService } = setup({
      payload: { sub: USER_ID, tv: 0 },
      user: { _id: USER_ID, role: UserRole.ADMIN, tokenVersion: 1 },
    });
    await controller.create(claim, bearer);
    expect(ordersService.create).toHaveBeenCalledWith(claim, {
      trusted: false,
    });
  });

  it('a CUSTOMER session → untrusted', async () => {
    const { controller, ordersService } = setup({
      payload: { sub: USER_ID },
      user: { _id: USER_ID, role: UserRole.CUSTOMER },
    });
    await controller.create(claim, bearer);
    expect(ordersService.create).toHaveBeenCalledWith(claim, {
      trusted: false,
    });
  });

  it('an ADMIN session → trusted', async () => {
    const { controller, ordersService } = setup({
      payload: { sub: USER_ID },
      user: { _id: USER_ID, role: UserRole.ADMIN },
    });
    await controller.create(claim, bearer);
    expect(ordersService.create).toHaveBeenCalledWith(claim, { trusted: true });
  });

  it('a TRIBE session for someone else’s campaign → untrusted', async () => {
    const { controller, ordersService } = setup({
      payload: { sub: USER_ID },
      user: { _id: USER_ID, role: UserRole.TRIBE },
      ownsCampaign: false,
    });
    await controller.attachAddress(
      { campaignId: CAMPAIGN_ID, phone: '9876543210', address: {} } as any,
      bearer,
    );
    expect(ordersService.isCampaignOwnedBy).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      TRIBE_ID,
    );
    expect(ordersService.attachAddressByPhone.mock.calls[0][3].trusted).toBe(
      false,
    );
  });

  it('a TRIBE session for its own campaign → trusted', async () => {
    const { controller, ordersService } = setup({
      payload: { sub: USER_ID },
      user: { _id: USER_ID, role: UserRole.TRIBE },
      ownsCampaign: true,
    });
    await controller.create(claim, bearer);
    expect(ordersService.create).toHaveBeenCalledWith(claim, { trusted: true });
  });
});

describe('OrdersController ownership on tribe routes', () => {
  const tribeReq = { user: { _id: USER_ID, role: UserRole.TRIBE } };
  const adminReq = { user: { _id: USER_ID, role: UserRole.ADMIN } };

  it('a tribe cannot approve another tribe’s order', async () => {
    const { controller, ordersService } = setup();
    await expect(
      controller.approveOrder(ORDER_ID, '', [], tribeReq, USER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ordersService.approveOrder).not.toHaveBeenCalled();
  });

  it('a tribe cannot reject another tribe’s order', async () => {
    const { controller, ordersService } = setup();
    await expect(
      controller.rejectOrder(ORDER_ID, '', tribeReq, USER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ordersService.rejectOrder).not.toHaveBeenCalled();
  });

  it('a tribe can approve its own order, recorded under its user id', async () => {
    const { controller, ordersService } = setup();
    ordersService.findOne.mockResolvedValue({
      _id: ORDER_ID,
      coachId: TRIBE_ID,
    });
    await controller.approveOrder(ORDER_ID, 'ok', [], tribeReq, USER_ID);
    expect(ordersService.approveOrder).toHaveBeenCalledWith(
      ORDER_ID,
      USER_ID,
      'ok',
      [],
    );
  });

  it('an admin approves anything', async () => {
    const { controller, ordersService } = setup();
    await controller.approveOrder(ORDER_ID, '', [], adminReq, USER_ID);
    expect(ordersService.approveOrder).toHaveBeenCalledWith(
      ORDER_ID,
      'admin',
      '',
      [],
    );
  });
});

describe('Order DTO bounds', () => {
  const base = {
    coachId: TRIBE_ID,
    type: 'STORE_SALE',
    shippingAddress: { fullName: 'Ravi', phone: '9876543210' },
  };
  const errorsFor = async (cls: any, body: any) =>
    validate(plainToInstance(cls, body) as object);

  it.each([0, -1, 1.5, MAX_ITEM_QUANTITY + 1, 1e9])(
    'rejects quantity %p',
    async (quantity) => {
      const errors = await errorsFor(CreateOrderDto, {
        ...base,
        items: [{ productId: TRIBE_ID, quantity }],
      });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it('accepts a sane quantity', async () => {
    const errors = await errorsFor(CreateOrderDto, {
      ...base,
      items: [{ productId: TRIBE_ID, quantity: 3 }],
    });
    expect(errors).toEqual([]);
  });

  it('caps the number of lines', async () => {
    const items = Array.from({ length: MAX_ORDER_ITEMS + 1 }, () => ({
      productId: TRIBE_ID,
      quantity: 1,
    }));
    expect(
      (await errorsFor(CreateOrderDto, { ...base, items })).length,
    ).toBeGreaterThan(0);
  });

  it('status must be a real OrderStatus', async () => {
    expect(
      (await errorsFor(UpdateOrderStatusDto, { status: 'SHIPPED' })).length,
    ).toBeGreaterThan(0);
    expect(
      await errorsFor(UpdateOrderStatusDto, {
        status: 'PACKED',
        deliveryType: 'SPEED_POST',
      }),
    ).toEqual([]);
  });

  it('caps the media batch', async () => {
    const orderIds = Array.from(
      { length: MAX_MEDIA_ORDERS + 1 },
      () => ORDER_ID,
    );
    expect(
      (await errorsFor(DownloadMediaDto, { orderIds })).length,
    ).toBeGreaterThan(0);
  });
});
