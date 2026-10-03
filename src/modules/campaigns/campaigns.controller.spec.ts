import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CampaignsController } from './campaigns.controller';
import { CreateCampaignDto, UpdateCampaignDto } from './dto/campaign.dto';
import { UserRole } from '../../schemas/user.schema';
import { CampaignStatus } from '../../schemas/campaign.schema';

const MY_TRIBE = new Types.ObjectId().toString();
const OTHER_TRIBE = new Types.ObjectId().toString();
const PRODUCT = new Types.ObjectId().toString();

function setup(
  campaign: any = { coachId: { _id: MY_TRIBE }, status: CampaignStatus.ACTIVE },
) {
  const campaignsService = {
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue(campaign),
  };
  const tribesService = {
    findIdByUserId: jest.fn().mockResolvedValue(MY_TRIBE),
  };
  return {
    controller: new CampaignsController(
      campaignsService as any,
      tribesService as any,
    ),
    campaignsService,
  };
}

const tribeReq = { user: { role: UserRole.TRIBE } };
const adminReq = { user: { role: UserRole.ADMIN } };
const body = {
  coachId: OTHER_TRIBE,
  name: 'Kit',
  type: 'WELCOME_KIT',
  slug: 'kit',
  products: [{ productId: PRODUCT, retailPrice: 0 }],
} as CreateCampaignDto;

describe('CampaignsController.create', () => {
  it('forces a tribe’s campaign onto its own tribe', async () => {
    const { controller, campaignsService } = setup();
    await controller.create(body, tribeReq, 'user1');
    expect(campaignsService.create).toHaveBeenCalledWith(body, MY_TRIBE);
  });

  it('lets an admin choose the tribe, and requires one', async () => {
    const { controller, campaignsService } = setup();
    await controller.create(body, adminReq, 'admin1');
    expect(campaignsService.create).toHaveBeenCalledWith(body, OTHER_TRIBE);
    await expect(
      controller.create({ ...body, coachId: undefined }, adminReq, 'admin1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CampaignsController.update', () => {
  it('refuses another tribe’s campaign', async () => {
    const { controller, campaignsService } = setup({ coachId: OTHER_TRIBE });
    await expect(
      controller.update('c1', { name: 'x' }, tribeReq, 'user1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(campaignsService.update).not.toHaveBeenCalled();
  });

  it('ignores a tribe’s attempt to reassign the campaign', async () => {
    const { controller, campaignsService } = setup();
    await controller.update('c1', { coachId: OTHER_TRIBE }, tribeReq, 'user1');
    expect(campaignsService.update).toHaveBeenCalledWith(
      'c1',
      { coachId: OTHER_TRIBE },
      MY_TRIBE,
    );
  });

  it('only an admin can reactivate a stopped campaign', async () => {
    const stopped = { coachId: MY_TRIBE, status: CampaignStatus.STOPPED };
    const tribe = setup(stopped);
    await expect(
      tribe.controller.update(
        'c1',
        { status: CampaignStatus.ACTIVE },
        tribeReq,
        'user1',
      ),
    ).rejects.toThrow('Only an admin can reactivate');

    const admin = setup(stopped);
    await admin.controller.update(
      'c1',
      { status: CampaignStatus.ACTIVE },
      adminReq,
      'a1',
    );
    expect(admin.campaignsService.update).toHaveBeenCalled();
  });
});

describe('Campaign DTOs', () => {
  // Mirrors main.ts: whitelist + forbidNonWhitelisted.
  const errorsFor = (cls: any, payload: any) =>
    validate(plainToInstance(cls, payload) as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('rejects operator keys and server-managed fields', async () => {
    expect(
      (await errorsFor(UpdateCampaignDto, { $set: { coachId: OTHER_TRIBE } }))
        .length,
    ).toBeGreaterThan(0);
    expect(
      (await errorsFor(UpdateCampaignDto, { claims: 999 })).length,
    ).toBeGreaterThan(0);
  });

  it('accepts what the campaign forms send (deliveryType null clears it)', async () => {
    expect(
      await errorsFor(CreateCampaignDto, {
        ...body,
        formType: 'WITH_ADDRESS',
        deliveryType: null,
        length: 10,
        packageWeight: 500,
        successMessage: 'Thanks!',
      }),
    ).toEqual([]);
    expect(await errorsFor(UpdateCampaignDto, { status: 'PAUSED' })).toEqual(
      [],
    );
  });

  it('kit fields: products optional with a kit, kitPrice 2 dp at most, null allowed', async () => {
    const { products, ...noProducts } = body;
    expect(products).toBeDefined();
    expect(await errorsFor(CreateCampaignDto, noProducts)).not.toEqual([]);
    expect(
      await errorsFor(CreateCampaignDto, {
        ...noProducts,
        kitId: PRODUCT,
        kitPrice: 499.5,
      }),
    ).toEqual([]);
    expect(
      (
        await errorsFor(CreateCampaignDto, {
          ...noProducts,
          kitId: PRODUCT,
          kitPrice: 1.234,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      await errorsFor(UpdateCampaignDto, { kitId: null, kitPrice: null }),
    ).toEqual([]);
    expect(
      (await errorsFor(UpdateCampaignDto, { kitId: 'nope' })).length,
    ).toBeGreaterThan(0);
    // A form may echo a line's quantity back.
    expect(
      await errorsFor(UpdateCampaignDto, {
        products: [{ productId: PRODUCT, quantity: 2 }],
      }),
    ).toEqual([]);
  });
});
