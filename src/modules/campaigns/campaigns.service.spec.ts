import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CampaignsService } from './campaigns.service';

const TRIBE = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const P1 = new Types.ObjectId().toString();
const P2 = new Types.ObjectId().toString();

const exec = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    lean: () => q,
  };
  return q;
};

function setup(ownedCount: number) {
  const campaignModel: any = jest.fn().mockImplementation((doc) => ({
    ...doc,
    save: jest.fn().mockResolvedValue(doc),
  }));
  campaignModel.findById = jest.fn(() =>
    exec({ coachId: TRIBE, products: [{ productId: P1 }] }),
  );
  campaignModel.findByIdAndUpdate = jest.fn(() => exec({ _id: 'c1' }));
  const productModel: any = { countDocuments: jest.fn(() => exec(ownedCount)) };
  return {
    service: new CampaignsService(campaignModel, productModel),
    campaignModel,
    productModel,
  };
}

describe('CampaignsService', () => {
  it('refuses products that are not all the tribe’s own', async () => {
    const { service, campaignModel } = setup(1);
    await expect(
      service.create(
        {
          name: 'Kit',
          type: 'WELCOME_KIT' as any,
          slug: 'kit',
          products: [{ productId: P1 }, { productId: P2 }],
        },
        TRIBE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(campaignModel).not.toHaveBeenCalled();
  });

  it('creates under the given tribe with only known fields', async () => {
    const { service, campaignModel, productModel } = setup(1);
    await service.create(
      {
        name: 'Kit',
        type: 'WELCOME_KIT' as any,
        slug: 'kit',
        products: [{ productId: P1 }],
        coachId: OTHER,
      },
      TRIBE,
    );
    expect(productModel.countDocuments.mock.calls[0][0]).toMatchObject({
      coachId: TRIBE,
    });
    const doc = campaignModel.mock.calls[0][0];
    expect(doc.coachId).toBe(TRIBE);
    expect(doc).not.toHaveProperty('claims');
  });

  it('updates through an explicit $set, never the raw body', async () => {
    const { service, campaignModel } = setup(1);
    const dto: any = { name: 'New', $set: { claims: 0 }, claims: 5 };
    await service.update('c1', dto, TRIBE);
    const [, update] = campaignModel.findByIdAndUpdate.mock.calls[0];
    expect(update).toEqual({ $set: { name: 'New' } });
  });

  it('re-checks existing products when an admin reassigns the tribe', async () => {
    const { service, productModel } = setup(0);
    await expect(
      service.update('c1', { coachId: OTHER }, OTHER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(productModel.countDocuments.mock.calls[0][0]).toMatchObject({
      coachId: OTHER,
    });
  });
});
