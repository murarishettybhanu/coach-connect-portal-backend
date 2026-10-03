import { ForbiddenException } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { UserRole } from '../../schemas/user.schema';

function setup() {
  const productsService = {
    findAll: jest.fn().mockResolvedValue([]),
    findByCoach: jest
      .fn()
      .mockResolvedValue([{ stockLevel: -3, baseProductionCost: 90 }]),
    findDeletedByCoach: jest.fn().mockResolvedValue([]),
    findOne: jest
      .fn()
      .mockResolvedValue({
        coachId: 'tribe2',
        stockLevel: -1,
        baseProductionCost: 90,
      }),
  };
  const tribesService = {
    findIdByUserId: jest.fn().mockResolvedValue('tribe1'),
  };
  return {
    controller: new ProductsController(
      productsService as any,
      tribesService as any,
    ),
    productsService,
  };
}

const tribeReq = { user: { role: UserRole.TRIBE } };
const adminReq = { user: { role: UserRole.ADMIN } };

describe('ProductsController reads', () => {
  it('scopes a tribe to its own products, whatever coachId it asks for', async () => {
    const { controller, productsService } = setup();
    const res = await controller.findAll(tribeReq, 'user1', 'tribe2', 'true');
    expect(productsService.findByCoach).toHaveBeenCalledWith('tribe1');
    expect(productsService.findDeletedByCoach).not.toHaveBeenCalled();
    expect(productsService.findAll).not.toHaveBeenCalled();
    // Shortfall hidden, own production cost still visible.
    expect(res[0]).toMatchObject({ stockLevel: 0, baseProductionCost: 90 });
  });

  it('leaves the admin listing unchanged', async () => {
    const { controller, productsService } = setup();
    await controller.findAll(adminReq, 'a1', 'tribe2', 'true');
    expect(productsService.findDeletedByCoach).toHaveBeenCalledWith('tribe2');
    await controller.findAll(adminReq, 'a1');
    expect(productsService.findAll).toHaveBeenCalled();
  });

  it('refuses a tribe another tribe’s product', async () => {
    const { controller } = setup();
    await expect(
      controller.findOne(tribeReq, 'user1', 'p1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('shows a tribe its own product', async () => {
    const { controller, productsService } = setup();
    productsService.findOne.mockResolvedValue({
      coachId: 'tribe1',
      stockLevel: -1,
      baseProductionCost: 90,
    });
    expect(await controller.findOne(tribeReq, 'user1', 'p1')).toMatchObject({
      stockLevel: 0,
      baseProductionCost: 90,
    });
  });
});
