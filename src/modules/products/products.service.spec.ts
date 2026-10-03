import { ForbiddenException } from '@nestjs/common';
import { ProductsService } from './products.service';

const exec = (value: any) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(product: any) {
  const productModel: any = {
    findById: jest.fn(() => exec(product)),
    updateOne: jest.fn(() => exec({})),
  };
  return {
    service: new ProductsService(productModel, {} as any, {} as any),
    productModel,
  };
}

describe('ProductsService', () => {
  it('a tribe cannot change store settings on another tribe’s product', async () => {
    const product = { coachId: 'tribe2', save: jest.fn() };
    const { service } = setup(product);
    await expect(
      service.updateStoreSettings('p1', { retailPrice: 1 }, 'tribe1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(product.save).not.toHaveBeenCalled();
  });

  it('an unsized stock move is one atomic $inc on the total', async () => {
    const { service, productModel } = setup({});
    await service.decrementStock('p1', 2);
    expect(productModel.updateOne).toHaveBeenCalledWith(
      { _id: 'p1' },
      { $inc: { stockLevel: -2 } },
    );
  });
});
