import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TransactionsService } from './transactions.service';
import { TransactionType } from '../../schemas/transaction.schema';

const COACH = new Types.ObjectId().toString();
const ORDER = new Types.ObjectId().toString();

const exec = (value: any) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup() {
  const model: any = jest.fn().mockImplementation((doc) => ({
    ...doc,
    _id: new Types.ObjectId(),
    save: model.save,
  }));
  model.save = jest.fn(function (this: any) {
    return Promise.resolve(this);
  });
  model.aggregate = jest.fn();
  model.exists = jest.fn().mockResolvedValue(null);
  model.deleteOne = jest.fn(() => exec({}));
  return { service: new TransactionsService(model), model };
}

/** Each aggregate call answers with the next balance. */
const balances = (model: any, ...values: number[]) => {
  for (const v of values)
    model.aggregate.mockReturnValueOnce(exec([{ balance: v }]));
};

describe('TransactionsService.getBalance', () => {
  it('sums the ledger in one $group, matching the tribe as an ObjectId', async () => {
    const { service, model } = setup();
    balances(model, 750);
    expect(await service.getBalance(COACH)).toBe(750);
    const [pipeline] = model.aggregate.mock.calls[0];
    expect(pipeline[0].$match.coachId).toBeInstanceOf(Types.ObjectId);
    expect(pipeline[1].$group).toBeDefined();
  });

  it('is 0 for a tribe with no ledger', async () => {
    const { service, model } = setup();
    model.aggregate.mockReturnValueOnce(exec([]));
    expect(await service.getBalance(COACH)).toBe(0);
  });
});

describe('TransactionsService.createPayout', () => {
  it('refuses more than the balance', async () => {
    const { service, model } = setup();
    balances(model, 100);
    await expect(
      service.createPayout({ coachId: COACH, amount: 500 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(model.save).not.toHaveBeenCalled();
  });

  it('records a payout within the balance', async () => {
    const { service, model } = setup();
    balances(model, 1000, 500);
    const payout: any = await service.createPayout({
      coachId: COACH,
      amount: 500,
      utrReference: ' UTR1 ',
    });
    expect(payout.type).toBe(TransactionType.PAYOUT);
    expect(payout.utrReference).toBe('UTR1');
    expect(model.deleteOne).not.toHaveBeenCalled();
  });

  it('backs itself out when a concurrent payout overdrew the balance', async () => {
    const { service, model } = setup();
    // Both saw 1000 before inserting; after both inserts the ledger is -200.
    balances(model, 1000, -200);
    await expect(
      service.createPayout({ coachId: COACH, amount: 600 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(model.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('refuses a UTR that is already recorded', async () => {
    const { service, model } = setup();
    model.exists.mockResolvedValue({ _id: 'x' });
    await expect(
      service.createPayout({
        coachId: COACH,
        amount: 10,
        utrReference: 'UTR1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(model.save).not.toHaveBeenCalled();
  });

  it('maps a duplicate-key race on the UTR index to a conflict', async () => {
    const { service, model } = setup();
    balances(model, 1000);
    model.save.mockRejectedValueOnce(
      Object.assign(new Error('E11000'), { code: 11000 }),
    );
    await expect(
      service.createPayout({
        coachId: COACH,
        amount: 10,
        utrReference: 'UTR1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TransactionsService.reverseByOrder', () => {
  it('appends a negative commission for what the order still carries', async () => {
    const { service, model } = setup();
    model.aggregate.mockReturnValueOnce(exec([{ _id: COACH, net: 250 }]));
    await service.reverseByOrder(ORDER, 'Order deleted');
    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.COMMISSION,
        amount: -250,
        orderId: ORDER,
      }),
    );
  });

  it('is idempotent once the order nets to zero', async () => {
    const { service, model } = setup();
    model.aggregate.mockReturnValueOnce(exec([{ _id: COACH, net: 0 }]));
    await service.reverseByOrder(ORDER);
    expect(model.save).not.toHaveBeenCalled();
  });
});
