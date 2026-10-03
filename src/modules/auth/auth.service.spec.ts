import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../../schemas/user.schema';

describe('AuthService', () => {
  let service: AuthService;
  let users: {
    findOneByEmail: jest.Mock;
    findOneById: jest.Mock;
    updatePassword: jest.Mock;
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  let user: Record<string, unknown>;

  beforeEach(async () => {
    user = {
      _id: '64b000000000000000000001',
      email: 'asha@example.com',
      name: 'Asha',
      role: UserRole.TRIBE,
      password: await bcrypt.hash('correct-horse', 4),
      tokenVersion: 3,
    };
    users = {
      findOneByEmail: jest.fn().mockResolvedValue(user),
      findOneById: jest.fn().mockResolvedValue(user),
      updatePassword: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('login', () => {
    it('returns a token stamped with the user and their token version', async () => {
      const result = await service.login('asha@example.com', 'correct-horse');

      expect(result.user).toEqual({
        id: user._id,
        email: 'asha@example.com',
        name: 'Asha',
        role: UserRole.TRIBE,
      });
      expect(jwt.verify(result.access_token)).toMatchObject({
        sub: '64b000000000000000000001',
        role: UserRole.TRIBE,
        tv: 3,
      });
    });

    it('treats a user from before token versions as version 0', async () => {
      delete user.tokenVersion;
      const result = await service.login('asha@example.com', 'correct-horse');
      expect(jwt.verify(result.access_token)).toMatchObject({ tv: 0 });
    });

    it('rejects a wrong password', async () => {
      await expect(
        service.login('asha@example.com', 'wrong'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('gives an unknown email the same answer as a wrong password', async () => {
      users.findOneByEmail.mockResolvedValueOnce(null);
      const unknown = await service
        .login('nobody@example.com', 'x')
        .catch((e: Error) => e.message);
      const wrong = await service
        .login('asha@example.com', 'wrong')
        .catch((e: Error) => e.message);
      expect(unknown).toBe(wrong);
    });
  });

  describe('changePassword', () => {
    it('stores the new hash and hands back a token for the bumped version', async () => {
      // updatePassword bumps tokenVersion; the re-read sees it.
      users.findOneById
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ ...user, tokenVersion: 4 });

      const result = await service.changePassword(
        String(user._id),
        'correct-horse',
        'battery-staple',
      );

      const [id, hash] = users.updatePassword.mock.calls[0] as [string, string];
      expect(id).toBe(user._id);
      expect(await bcrypt.compare('battery-staple', hash)).toBe(true);
      expect(jwt.verify(result.access_token)).toMatchObject({ tv: 4 });
    });

    it('refuses when the current password is wrong', async () => {
      await expect(
        service.changePassword(String(user._id), 'wrong', 'battery-staple'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.updatePassword).not.toHaveBeenCalled();
    });
  });

  it('no longer offers self-registration', () => {
    expect(
      (service as unknown as Record<string, unknown>).register,
    ).toBeUndefined();
  });
});
