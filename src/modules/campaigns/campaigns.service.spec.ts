import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CampaignsService } from './campaigns.service';
import { CampaignStatus } from '../../schemas/campaign.schema';

const TRIBE = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const P1 = new Types.ObjectId().toString();
const P2 = new Types.ObjectId().toString();
const KIT = new Types.ObjectId().toString();
const CAMPAIGN = new Types.ObjectId().toString();

/** A chainable stand-in for a Mongoose query that resolves to `value()`. */
const exec = (value: any, calls?: any[]) => {
  const q: any = {
    exec: jest.fn(async () => (typeof value === 'function' ? value() : value)),
    select: () => q,
    lean: () => q,
    populate: (arg: any) => {
      calls?.push(arg);
      return q;
    },
  };
  return q;
};

// Kit: 2 × P1 (cost 100, retail 300) + 1 × P2 (cost 50, retail 120).
// minPrice = 250, productValue = 720.
const products = [
  { _id: P1, retailPrice: 300, baseProductionCost: 100 },
  { _id: P2, retailPrice: 120, baseProductionCost: 50 },
];
const kitDoc = (extra: any = {}) => ({
  _id: KIT,
  coachId: TRIBE,
  name: 'Starter kit',
  kitPrice: 400,
  isActive: true,
  isDeleted: false,
  items: [
    { productId: P1, quantity: 2 },
    { productId: P2, quantity: 1 },
  ],
  ...extra,
});

function setup(
  opts: {
    ownedCount?: number;
    existing?: any;
    kit?: any;
  } = {},
) {
  const { ownedCount = 1, kit = kitDoc() } = opts;
  const existing = opts.existing ?? {
    coachId: TRIBE,
    products: [{ productId: P1 }],
  };
  const populateCalls: any[] = [];
  const campaignModel: any = jest.fn().mockImplementation((doc) => ({
    ...doc,
    save: jest.fn().mockResolvedValue({ ...doc, _id: CAMPAIGN }),
  }));
  // A fresh copy per call: responses are shaped in place.
  campaignModel.findById = jest.fn(() =>
    exec(
      () => JSON.parse(JSON.stringify({ _id: CAMPAIGN, ...existing })),
      populateCalls,
    ),
  );
  campaignModel.findByIdAndUpdate = jest.fn(() => exec({ _id: CAMPAIGN }));
  const productModel: any = {
    countDocuments: jest.fn(() => exec(ownedCount)),
    find: jest.fn(() => exec(products)),
  };
  const kitModel: any = { findOne: jest.fn(() => exec(kit)) };
  return {
    service: new CampaignsService(campaignModel, productModel, kitModel),
    campaignModel,
    productModel,
    kitModel,
    populateCalls,
  };
}

const base = { name: 'Kit', type: 'WELCOME_KIT' as any, slug: 'kit' };

describe('CampaignsService', () => {
  it('refuses products that are not all the tribe’s own', async () => {
    const { service, campaignModel } = setup({ ownedCount: 1 });
    await expect(
      service.create(
        { ...base, products: [{ productId: P1 }, { productId: P2 }] },
        TRIBE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(campaignModel).not.toHaveBeenCalled();
  });

  it('creates under the given tribe with only known fields', async () => {
    const { service, campaignModel, productModel } = setup();
    await service.create(
      { ...base, products: [{ productId: P1 }], coachId: OTHER },
      TRIBE,
    );
    expect(productModel.countDocuments.mock.calls[0][0]).toMatchObject({
      coachId: TRIBE,
    });
    const doc = campaignModel.mock.calls[0][0];
    expect(doc.coachId).toBe(TRIBE);
    expect(doc).not.toHaveProperty('claims');
    expect(doc.products).toEqual([
      { productId: P1, retailPrice: 0, quantity: 1 },
    ]);
    expect(doc.kitId).toBeNull();
  });

  it('updates through an explicit $set, never the raw body', async () => {
    const { service, campaignModel } = setup();
    const dto: any = { name: 'New', $set: { claims: 0 }, claims: 5 };
    await service.update('c1', dto, TRIBE);
    const [, update] = campaignModel.findByIdAndUpdate.mock.calls[0];
    expect(update).toEqual({ $set: { name: 'New' } });
  });

  it('re-checks existing products when an admin reassigns the tribe', async () => {
    const { service, productModel } = setup({ ownedCount: 0 });
    await expect(
      service.update('c1', { coachId: OTHER }, OTHER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(productModel.countDocuments.mock.calls[0][0]).toMatchObject({
      coachId: OTHER,
    });
  });
});

describe('CampaignsService — kit-linked campaigns', () => {
  it('takes products and quantities from the kit, ignoring any sent', async () => {
    const { service, campaignModel, kitModel } = setup();
    await service.create(
      { ...base, kitId: KIT, products: [{ productId: P2, retailPrice: 1 }] },
      TRIBE,
    );
    expect(kitModel.findOne.mock.calls[0][0]).toMatchObject({
      _id: KIT,
      coachId: TRIBE,
    });
    const doc = campaignModel.mock.calls[0][0];
    expect(doc.kitId).toBe(KIT);
    expect(doc.kitPrice).toBeNull();
    expect(doc.products).toEqual([
      { productId: P1, quantity: 2, retailPrice: 300 },
      { productId: P2, quantity: 1, retailPrice: 120 },
    ]);
  });

  it('accepts an override exactly at the minimum', async () => {
    const { service, campaignModel } = setup();
    await service.create({ ...base, kitId: KIT, kitPrice: 250 }, TRIBE);
    expect(campaignModel.mock.calls[0][0].kitPrice).toBe(250);
  });

  it('refuses an override below the production cost', async () => {
    const { service, campaignModel } = setup();
    await expect(
      service.create({ ...base, kitId: KIT, kitPrice: 249.99 }, TRIBE),
    ).rejects.toThrow(
      "Kit price can't be below the production cost of its products (₹250)",
    );
    expect(campaignModel).not.toHaveBeenCalled();
  });

  it('refuses a kit price on a campaign without a kit', async () => {
    const { service } = setup();
    await expect(
      service.create(
        { ...base, products: [{ productId: P1 }], kitPrice: 500 },
        TRIBE,
      ),
    ).rejects.toThrow(
      'A kit price can only be set on a campaign linked to a kit',
    );
    await expect(
      service.update('c1', { kitPrice: 500 }, TRIBE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a deactivated kit or another tribe’s kit', async () => {
    let { service } = setup({ kit: kitDoc({ isActive: false }) });
    await expect(
      service.create({ ...base, kitId: KIT }, TRIBE),
    ).rejects.toBeInstanceOf(BadRequestException);
    ({ service } = setup({ kit: null }));
    await expect(
      service.create({ ...base, kitId: KIT }, TRIBE),
    ).rejects.toThrow('Choose one of this tribe’s own kits');
  });

  const linked = {
    coachId: TRIBE,
    kitId: KIT,
    kitPrice: 500,
    status: CampaignStatus.ACTIVE,
    products: [
      { productId: P1, quantity: 2 },
      { productId: P2, quantity: 1 },
    ],
  };

  it('resets the override to the kit price with kitPrice: null', async () => {
    const { service, campaignModel } = setup({ existing: linked });
    await service.update(
      'c1',
      { kitPrice: null, products: [{ productId: P2 }] },
      TRIBE,
    );
    const [, { $set }] = campaignModel.findByIdAndUpdate.mock.calls[0];
    expect($set.kitPrice).toBeNull();
    expect($set.kitId).toBe(KIT);
    // Products stay the kit's, whatever was sent.
    expect($set.products.map((p: any) => p.quantity)).toEqual([2, 1]);
  });

  it('changes the override and checks it against the floor', async () => {
    const { service, campaignModel } = setup({ existing: linked });
    await service.update('c1', { kitPrice: 260.5 }, TRIBE);
    expect(campaignModel.findByIdAndUpdate.mock.calls[0][1].$set.kitPrice).toBe(
      260.5,
    );
    await expect(service.update('c1', { kitPrice: 10 }, TRIBE)).rejects.toThrow(
      '(₹250)',
    );
  });

  it('lets a linked campaign stop without re-checking its price', async () => {
    const { service, campaignModel } = setup({
      existing: { ...linked, kitPrice: 1 },
      kit: kitDoc({ isActive: false }),
    });
    await service.update('c1', { status: CampaignStatus.STOPPED }, TRIBE);
    expect(campaignModel.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('a re-save that re-sends the same kitId tolerates a kit deactivated since', async () => {
    const { service, campaignModel } = setup({
      existing: linked,
      kit: kitDoc({ isActive: false }),
    });
    await service.update(
      'c1',
      { kitId: KIT, kitPrice: 500, name: 'Renamed' },
      TRIBE,
    );
    expect(campaignModel.findByIdAndUpdate.mock.calls[0][1].$set).toMatchObject(
      {
        name: 'Renamed',
        kitId: KIT,
        kitPrice: 500,
      },
    );
  });

  it('but linking to another, deactivated kit is refused', async () => {
    const { service } = setup({
      existing: { ...linked, kitId: new Types.ObjectId().toString() },
      kit: kitDoc({ isActive: false }),
    });
    await expect(service.update('c1', { kitId: KIT }, TRIBE)).rejects.toThrow(
      'This kit is no longer active',
    );
  });

  it('a deleted kit is only tolerated while the campaign stays stopped', async () => {
    const stopped = { ...linked, status: CampaignStatus.STOPPED };
    let { service } = setup({
      existing: stopped,
      kit: kitDoc({ isDeleted: true }),
    });
    await expect(
      service.update('c1', { kitId: KIT, name: 'x' }, TRIBE),
    ).resolves.toBeDefined();
    ({ service } = setup({
      existing: stopped,
      kit: kitDoc({ isDeleted: true }),
    }));
    await expect(
      service.update(
        'c1',
        { kitId: KIT, status: CampaignStatus.ACTIVE },
        TRIBE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unchanged override is not re-checked against the floor', async () => {
    // Production cost rose to 250 since the override of 100 was set.
    const { service, campaignModel } = setup({
      existing: { ...linked, kitPrice: 100 },
    });
    await service.update(
      'c1',
      { kitId: KIT, kitPrice: 100, status: CampaignStatus.PAUSED },
      TRIBE,
    );
    expect(campaignModel.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('unlinks with kitId: null, clearing the price and taking body products at 1 each', async () => {
    const { service, campaignModel } = setup({ existing: linked });
    await service.update(
      'c1',
      {
        kitId: null,
        products: [{ productId: P1, retailPrice: 10, quantity: 5 }],
      },
      TRIBE,
    );
    const [, { $set }] = campaignModel.findByIdAndUpdate.mock.calls[0];
    expect($set).toMatchObject({
      kitId: null,
      kitPrice: null,
      products: [{ productId: P1, retailPrice: 10, quantity: 1 }],
    });
  });

  it('public responses carry effectivePrice and quantities but never cost or kitMinPrice', async () => {
    const { service, campaignModel, populateCalls } = setup();
    campaignModel.findOne = jest.fn(() =>
      exec(
        {
          slug: 'kit',
          kitId: { _id: KIT, name: 'Starter kit', kitPrice: 400 },
          kitPrice: null,
          products: [
            { productId: { _id: P1, name: 'Tee' }, quantity: 2 },
            { productId: { _id: P2, name: 'Cap' } }, // legacy: no quantity
            { productId: null }, // deleted product
          ],
        },
        populateCalls,
      ),
    );
    const res: any = await service.findBySlug('kit');
    expect(res.effectivePrice).toBe(400);
    expect(res).not.toHaveProperty('kitMinPrice');
    expect(res.kitId).toEqual({ _id: KIT, name: 'Starter kit', kitPrice: 400 });
    expect(res.products.map((p: any) => p.quantity)).toEqual([2, 1]);

    const productPopulate = populateCalls.find(
      (c) => c?.path === 'products.productId',
    );
    expect(productPopulate.select).toContain('-baseProductionCost');
    const kitPopulate = populateCalls.find((c) => c?.path === 'kitId');
    expect(kitPopulate.select).not.toContain('items');
    expect(kitPopulate.populate).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('baseProductionCost');
  });

  it('the public GET /campaigns/:id shape matches the slug one', async () => {
    const { service, populateCalls } = setup({
      existing: {
        kitId: { _id: KIT, name: 'K', kitPrice: null },
        kitPrice: 555,
        products: [],
      },
    });
    const res: any = await service.findOne(CAMPAIGN);
    expect(res.effectivePrice).toBe(555);
    expect(res).not.toHaveProperty('kitMinPrice');
    expect(
      populateCalls.find((c) => c?.path === 'kitId').populate,
    ).toBeUndefined();
  });

  it('signed-in lists carry kitMinPrice, without the cost behind it', async () => {
    const { service, campaignModel } = setup();
    campaignModel.find = jest.fn(() =>
      exec([
        {
          kitId: {
            _id: KIT,
            name: 'Starter kit',
            kitPrice: null,
            items: [
              { productId: { _id: P1, baseProductionCost: 100 }, quantity: 2 },
              {
                productId: { _id: P2, baseProductionCost: 50, isDeleted: true },
                quantity: 1,
              },
            ],
          },
          kitPrice: null,
          products: [],
        },
        { kitId: null, products: [{ productId: { _id: P1 } }] },
      ]),
    );
    const [linkedRes, legacy]: any[] = await service.findByCoach(TRIBE);
    expect(linkedRes.kitMinPrice).toBe(200);
    expect(linkedRes.effectivePrice).toBeNull();
    expect(linkedRes.kitId).toEqual({
      _id: KIT,
      name: 'Starter kit',
      kitPrice: null,
    });
    expect(legacy.effectivePrice).toBeNull();
    expect(legacy.kitId).toBeNull();
    expect(legacy.products[0].quantity).toBe(1);
  });
});
