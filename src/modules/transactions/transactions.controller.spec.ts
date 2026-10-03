import { TransactionsController } from './transactions.controller';

describe('TransactionsController', () => {
  const tribesService = {
    findIdByUserId: jest.fn().mockResolvedValue('tribe1'),
  };
  const transactionsService = {
    getBalance: jest.fn().mockResolvedValue(420),
    findByCoach: jest.fn().mockResolvedValue([]),
    createPayout: jest.fn(),
  };
  const controller = new TransactionsController(
    transactionsService as any,
    tribesService as any,
  );

  it('reads the balance of the caller’s own tribe', async () => {
    expect(await controller.getMyBalance('user1')).toEqual({ balance: 420 });
    expect(tribesService.findIdByUserId).toHaveBeenCalledWith('user1');
    expect(transactionsService.getBalance).toHaveBeenCalledWith('tribe1');
  });

  it('lists the caller’s own ledger', async () => {
    await controller.findMyTransactions('user1');
    expect(transactionsService.findByCoach).toHaveBeenCalledWith('tribe1');
  });
});
