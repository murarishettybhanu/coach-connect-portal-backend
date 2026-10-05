import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TribesService } from './tribes.service';

const exec = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    populate: () => q,
    select: () => q,
    lean: () => q,
  };
  return q;
};

function setup() {
  const tribeModel: any = jest.fn().mockImplementation((doc) => ({
    ...doc,
    save: tribeModel.save,
  }));
  tribeModel.save = jest.fn();
  tribeModel.exists = jest.fn().mockResolvedValue(null);
  tribeModel.find = jest.fn();
  tribeModel.findById = jest.fn();
  tribeModel.findByIdAndUpdate = jest.fn(() => exec({}));
  const userModel: any = { deleteOne: jest.fn(() => exec({})) };
  const usersService = {
    findOneByEmail: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ _id: 'user1' }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const transactions = { getBalance: jest.fn(), getBalances: jest.fn() };
  const mail = { sendTribeWelcome: jest.fn().mockResolvedValue(true) };
  const service = new TribesService(
    tribeModel,
    userModel,
    usersService as any,
    transactions as any,
    mail as any,
  );
  return { service, tribeModel, userModel, usersService, transactions };
}

const onboarding = {
  email: 'a@b.com',
  name: 'Asha',
  phoneNumber: '9876543210',
  username: 'asha',
};

describe('TribesService.create', () => {
  it('refuses a taken username before creating the login', async () => {
    const { service, tribeModel, usersService } = setup();
    tribeModel.exists.mockResolvedValue({ _id: 'x' });
    await expect(service.create(onboarding)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('deletes the new login when the tribe cannot be saved', async () => {
    const { service, tribeModel, userModel } = setup();
    tribeModel.save.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 11000 }),
    );
    await expect(service.create(onboarding)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(userModel.deleteOne).toHaveBeenCalledWith({ _id: 'user1' });
  });
});

describe('TribesService.findAll', () => {
  it('reads every balance in one aggregation', async () => {
    const { service, tribeModel, transactions } = setup();
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    tribeModel.find.mockReturnValue(
      exec([a, b].map((_id) => ({ _id, toObject: () => ({ _id }) }))),
    );
    transactions.getBalances.mockResolvedValue(new Map([[String(a), 120]]));
    const rows = await service.findAll();
    expect(transactions.getBalances).toHaveBeenCalledTimes(1);
    expect(transactions.getBalance).not.toHaveBeenCalled();
    expect(rows.map((r) => r.walletBalance)).toEqual([120, 0]);
  });
});

describe('TribesService.update', () => {
  it('writes an explicit $set of known fields only', async () => {
    const { service, tribeModel } = setup();
    tribeModel.findById.mockReturnValue(exec({ userId: 'user1' }));
    await service.update('t1', {
      brand: 'B',
      walletBalance: 1e6,
      $set: {},
    } as any);
    const [, update] = tribeModel.findByIdAndUpdate.mock.calls[0];
    expect(update).toEqual({ $set: { brand: 'B' } });
  });

  it('merges storefrontConfig, so saving the theme keeps the banner', async () => {
    const { service, tribeModel } = setup();
    const stored = {
      userId: 'user1',
      storefrontConfig: { bannerImage: 'b.png', themeColor: '#111111' },
    };
    tribeModel.findById.mockReturnValue(
      exec({ ...stored, toObject: () => stored }),
    );
    const theme = { colors: { primary: '#FF5500' }, headingFont: 'Poppins' };
    await service.update('t1', { storefrontConfig: { theme } } as any);
    const [, update] = tribeModel.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.storefrontConfig).toEqual({
      bannerImage: 'b.png',
      themeColor: '#111111',
      theme,
    });
  });

  it('merges onto a stored null or missing storefrontConfig', async () => {
    const { service, tribeModel } = setup();
    const stored = { userId: 'user1', storefrontConfig: null };
    tribeModel.findById.mockReturnValue(
      exec({ ...stored, toObject: () => stored }),
    );
    await service.update('t1', { storefrontConfig: { theme: null } } as any);
    const [, update] = tribeModel.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.storefrontConfig).toEqual({ theme: null });
  });
});

describe('TribesService.updatePermissions', () => {
  it('merges onto the effective permissions and writes them all', async () => {
    const { service, tribeModel } = setup();
    tribeModel.findById.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: async () => ({ permissions: {} }) }),
      }),
    });
    tribeModel.updateOne = jest.fn(() => exec({}));
    const expected = {
      members: true,
      campaigns: true,
      storefront: true,
      analytics: false,
    };
    await expect(
      service.updatePermissions('t1', { members: true }),
    ).resolves.toEqual(expected);
    expect(tribeModel.updateOne).toHaveBeenCalledWith(
      { _id: 't1' },
      { $set: { permissions: expected } },
    );
  });
});
