import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TribeKitsService } from './tribe-kits.service';
import { TribeKitsController } from './tribe-kits.controller';
import { CreateTribeKitDto, UpdateTribeKitDto } from './dto/tribe-kit.dto';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

const TRIBE = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const P1 = new Types.ObjectId().toString();
const P2 = new Types.ObjectId().toString();
const KIT = new Types.ObjectId().toString();

const q = (value: any) => {
  const chain: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => chain,
    lean: () => chain,
    populate: () => chain,
    sort: () => chain,
  };
  return chain;
};

// P1: cost 100 / retail 300; P2: cost 50 / retail 120.
const PRODUCTS = [
  { _id: P1, retailPrice: 300, baseProductionCost: 100 },
  { _id: P2, retailPrice: 120, baseProductionCost: 50 },
];

function setup(
  opts: { kit?: any; products?: any[]; linked?: any[]; tooLow?: any[] } = {},
) {
  const kit = opts.kit ?? {
    _id: KIT,
    coachId: TRIBE,
    name: 'Kit',
    kitPrice: null,
    isActive: true,
    items: [{ productId: P1, quantity: 1 }],
  };
  const kitModel: any = {
    create: jest.fn(async (doc) => ({ _id: KIT, ...doc })),
    findOne: jest.fn(() => q(kit)),
    findOneAndUpdate: jest.fn(() => q({ ...kit, _id: KIT })),
    findByIdAndUpdate: jest.fn(() => q({ ...kit, isDeleted: true })),
    exists: jest.fn().mockResolvedValue({ _id: KIT }),
    find: jest.fn(),
  };
  const campaignModel: any = {
    // Two different finds: the "active linked" lookup and the "override too
    // low" lookup — told apart by their filter.
    find: jest.fn((filter: any) =>
      q(filter.kitPrice ? (opts.tooLow ?? []) : (opts.linked ?? [])),
    ),
    updateMany: jest.fn(() => q({ modifiedCount: 1 })),
    aggregate: jest.fn(() => q([])),
  };
  const productModel: any = {
    find: jest.fn(() => q(opts.products ?? PRODUCTS)),
  };
  return {
    service: new TribeKitsService(kitModel, campaignModel, productModel),
    kitModel,
    campaignModel,
    productModel,
  };
}

const create = (extra: any = {}): CreateTribeKitDto => ({
  coachId: TRIBE,
  name: 'Kit',
  items: [
    { productId: P1, quantity: 2 },
    { productId: P2, quantity: 1 },
  ],
  ...extra,
});

describe('Tribe kit DTOs', () => {
  const errorsFor = (cls: any, payload: any) =>
    validate(plainToInstance(cls, payload) as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts what the kit form sends, with or without a price', async () => {
    const form = {
      coachId: TRIBE,
      name: 'Kit',
      description: '',
      imageUrl: '',
      isActive: true,
      items: [{ productId: P1, quantity: 2 }],
    };
    expect(await errorsFor(CreateTribeKitDto, form)).toEqual([]);
    expect(
      await errorsFor(CreateTribeKitDto, { ...form, kitPrice: 499.99 }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateTribeKitDto, { ...form, kitPrice: null }),
    ).toEqual([]);
  });

  it.each([
    ['no coachId', { coachId: undefined }],
    ['no items', { items: [] }],
    ['quantity 0', { items: [{ productId: P1, quantity: 0 }] }],
    ['quantity 101', { items: [{ productId: P1, quantity: 101 }] }],
    ['fractional quantity', { items: [{ productId: P1, quantity: 1.5 }] }],
    ['bad product id', { items: [{ productId: 'x', quantity: 1 }] }],
    ['3-dp price', { kitPrice: 10.123 }],
    ['negative price', { kitPrice: -1 }],
    ['unknown field', { isDeleted: true }],
    ['operator key', { $set: { coachId: OTHER } }],
  ])('rejects %s on create', async (_label, patch) => {
    const payload: any = { ...create(), ...patch };
    expect(
      (await errorsFor(CreateTribeKitDto, payload)).length,
    ).toBeGreaterThan(0);
  });

  it('kit writes stay admin-only', () => {
    for (const handler of ['create', 'update', 'remove'] as const) {
      expect(
        Reflect.getMetadata(ROLES_KEY, TribeKitsController.prototype[handler]),
      ).toEqual([UserRole.ADMIN]);
    }
  });
});

describe('TribeKitsService.create', () => {
  it('stores an explicit build with the price, at exactly the minimum', async () => {
    const { service, kitModel, productModel } = setup();
    await service.create({
      ...create({ kitPrice: 250 }),
      isDeleted: true,
    } as any);
    expect(productModel.find.mock.calls[0][0]).toMatchObject({
      coachId: TRIBE,
    });
    const doc = kitModel.create.mock.calls[0][0];
    expect(doc.kitPrice).toBe(250);
    expect(doc).not.toHaveProperty('isDeleted');
  });

  it('defaults to no custom price', async () => {
    const { service, kitModel } = setup();
    await service.create(create());
    expect(kitModel.create.mock.calls[0][0].kitPrice).toBeNull();
  });

  it('refuses a price below the production cost (Σ cost × qty)', async () => {
    const { service, kitModel } = setup();
    await expect(service.create(create({ kitPrice: 249.99 }))).rejects.toThrow(
      "Kit price can't be below the production cost of its products (₹250)",
    );
    expect(kitModel.create).not.toHaveBeenCalled();
  });

  it('refuses products that are not the tribe’s own', async () => {
    const { service } = setup({ products: [PRODUCTS[0]] });
    await expect(service.create(create())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('TribeKitsService.update — live sync and limits', () => {
  it('replaces every linked campaign’s products with the kit’s', async () => {
    const { service, campaignModel, kitModel } = setup();
    await service.update(KIT, { items: create().items });
    expect(kitModel.findOneAndUpdate.mock.calls[0][1].$set.items).toEqual(
      create().items,
    );
    const [filter, update] = campaignModel.updateMany.mock.calls[0];
    expect(filter).toEqual({ kitId: KIT });
    expect(update.$set.products).toEqual([
      { productId: P1, quantity: 2, retailPrice: 300 },
      { productId: P2, quantity: 1, retailPrice: 120 },
    ]);
  });

  it('400s when the kit’s own price would fall below the new minimum', async () => {
    const { service, campaignModel } = setup({
      kit: {
        _id: KIT,
        coachId: TRIBE,
        kitPrice: 200,
        isActive: true,
        items: [],
      },
    });
    await expect(
      service.update(KIT, { items: create().items }),
    ).rejects.toThrow('(₹250)');
    expect(campaignModel.updateMany).not.toHaveBeenCalled();
  });

  it('409s, naming them, when campaign overrides fall below the new minimum', async () => {
    const { service, campaignModel, kitModel } = setup({
      tooLow: [{ name: 'Diwali' }, { name: 'Onboarding' }],
    });
    const err = await service
      .update(KIT, { items: create().items })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      'These campaigns have a kit price below the new minimum (₹250): Diwali, Onboarding. Raise their price first.',
    );
    const [filter] = campaignModel.find.mock.calls.find(
      ([f]: any) => f.kitPrice,
    );
    expect(filter).toEqual({ kitId: KIT, kitPrice: { $ne: null, $lt: 250 } });
    expect(kitModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(campaignModel.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to move a kit to another tribe', async () => {
    const { service } = setup();
    await expect(
      service.update(KIT, { coachId: OTHER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the same coachId the form always sends', async () => {
    const { service, kitModel } = setup();
    await service.update(KIT, { coachId: TRIBE, name: 'Renamed' });
    expect(kitModel.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      name: 'Renamed',
    });
  });

  it('409s deactivating a kit that active campaigns use', async () => {
    const { service, campaignModel, kitModel } = setup({
      linked: [{ name: 'Diwali' }],
    });
    const err = await service.update(KIT, { isActive: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      'This kit is used by active campaigns: Diwali. Stop them or switch them to products first.',
    );
    expect(campaignModel.find.mock.calls[0][0]).toEqual({
      kitId: KIT,
      status: { $ne: 'STOPPED' },
    });
    expect(kitModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('deactivates when only stopped campaigns use it', async () => {
    const { service, kitModel } = setup({ linked: [] });
    await service.update(KIT, { isActive: false });
    expect(kitModel.findOneAndUpdate.mock.calls[0][1].$set.isActive).toBe(
      false,
    );
  });
});

describe('TribeKitsService.remove', () => {
  it('409s while active campaigns use the kit', async () => {
    const { service, kitModel } = setup({
      linked: [{ name: 'Diwali' }, { name: 'Holi' }],
    });
    await expect(service.remove(KIT)).rejects.toThrow(
      'This kit is used by active campaigns: Diwali, Holi. Stop them or switch them to products first.',
    );
    expect(kitModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('soft-deletes otherwise', async () => {
    const { service, kitModel } = setup({ linked: [] });
    await service.remove(KIT);
    expect(kitModel.findByIdAndUpdate.mock.calls[0][1]).toEqual({
      isDeleted: true,
      isActive: false,
    });
  });
});

describe('TribeKitsService.findByCoach', () => {
  it('reports productValue, minPrice and active linked campaigns per kit', async () => {
    const { service, kitModel, campaignModel } = setup();
    kitModel.find.mockReturnValue(
      q([
        {
          _id: new Types.ObjectId(KIT),
          kitPrice: 500,
          items: [
            { productId: { ...PRODUCTS[0], stockLevel: 10 }, quantity: 2 },
            { productId: { ...PRODUCTS[1], stockLevel: 3 }, quantity: 1 },
            {
              productId: {
                _id: OTHER,
                retailPrice: 9,
                baseProductionCost: 9,
                isDeleted: true,
              },
              quantity: 1,
            },
          ],
        },
      ]),
    );
    campaignModel.aggregate.mockReturnValue(
      q([{ _id: new Types.ObjectId(KIT), n: 2 }]),
    );
    const [kit]: any[] = await service.findByCoach(TRIBE);
    expect(kit).toMatchObject({
      kitPrice: 500,
      productValue: 720,
      minPrice: 250,
      linkedCampaigns: 2,
      availableKits: 0,
    });
    expect(campaignModel.aggregate.mock.calls[0][0][0].$match.status).toEqual({
      $ne: 'STOPPED',
    });
  });
});
