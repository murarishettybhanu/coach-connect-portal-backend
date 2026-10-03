import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from '../../schemas/user.schema';

/** A Mongoose-style query whose `.exec()` resolves to `result`. */
const query = (result: unknown) => ({
  exec: jest.fn().mockResolvedValue(result),
});

describe('UsersService', () => {
  let service: UsersService;
  let findOne: jest.Mock;
  let findByIdAndUpdate: jest.Mock;
  let saved: Record<string, unknown>[];

  beforeEach(async () => {
    findOne = jest.fn(() => query(null));
    findByIdAndUpdate = jest.fn(() => query(null));
    saved = [];

    // `new this.userModel(data).save()` — a constructor with statics.
    const UserModel = jest.fn().mockImplementation((data) => ({
      ...data,
      save: jest.fn(() => {
        saved.push(data);
        return Promise.resolve(data);
      }),
    }));
    Object.assign(UserModel, {
      findOne,
      findByIdAndUpdate,
      findById: jest.fn(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getModelToken(User.name), useValue: UserModel },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('emails', () => {
    it('stores a new email trimmed and lowercased', async () => {
      await service.create({ email: '  Asha@Example.COM ', name: 'Asha' });
      expect(saved[0].email).toBe('asha@example.com');
    });

    it('looks an email up lowercased', async () => {
      const user = { _id: '1', email: 'asha@example.com' };
      findOne.mockReturnValueOnce(query(user));

      await expect(service.findOneByEmail(' ASHA@example.com')).resolves.toBe(
        user,
      );
      expect(findOne).toHaveBeenCalledWith({ email: 'asha@example.com' });
    });

    it('still finds an older account stored in mixed case', async () => {
      const legacy = { _id: '1', email: 'Asha@Example.com' };
      findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(legacy));

      await expect(service.findOneByEmail('asha@example.com')).resolves.toBe(
        legacy,
      );
      const [filter] = findOne.mock.calls[1] as [
        { email: { $regex: string; $options: string } },
      ];
      expect(filter.email).toEqual({
        $regex: '^asha@example\\.com$',
        $options: 'i',
      });
    });

    it('escapes the input in the fallback, so it matches one address only', async () => {
      await service.findOneByEmail('a.*@x.com');
      const [filter] = findOne.mock.calls[1] as [{ email: { $regex: string } }];
      expect(filter.email.$regex).toBe('^a\\.\\*@x\\.com$');
    });

    it('lowercases an email on update, and refuses one taken by someone else', async () => {
      await service.update('1', { email: 'New@Example.com' });
      expect(findByIdAndUpdate).toHaveBeenCalledWith('1', {
        $set: { email: 'new@example.com' },
      });

      findOne.mockReturnValueOnce(
        query({ _id: '2', email: 'taken@example.com' }),
      );
      await expect(
        service.update('1', { email: 'TAKEN@example.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updatePassword', () => {
    it('bumps tokenVersion so every existing session is signed out', async () => {
      await service.updatePassword('1', 'new-hash');
      expect(findByIdAndUpdate).toHaveBeenCalledWith('1', {
        $set: { password: 'new-hash' },
        $inc: { tokenVersion: 1 },
      });
    });
  });
});
