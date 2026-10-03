import { Test, TestingModule } from '@nestjs/testing';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './dto/login.dto';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { login: jest.Mock; changePassword: jest.Mock };

  beforeEach(async () => {
    authService = {
      login: jest.fn().mockResolvedValue({ access_token: 't', user: {} }),
      changePassword: jest
        .fn()
        .mockResolvedValue({ message: 'ok', access_token: 't2' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('logs in with the DTO credentials', async () => {
    await controller.login({ email: 'asha@example.com', password: 'pw' });
    expect(authService.login).toHaveBeenCalledWith('asha@example.com', 'pw');
  });

  it('changes the password for the signed-in user', async () => {
    await controller.changePassword(
      { currentPassword: 'old-password', newPassword: 'new-password' },
      { user: { _id: { toString: () => 'user-1' } } },
    );
    expect(authService.changePassword).toHaveBeenCalledWith(
      'user-1',
      'old-password',
      'new-password',
    );
  });

  it('exposes no public register route', () => {
    const routes = Object.getOwnPropertyNames(AuthController.prototype)
      .map((name) => (AuthController.prototype as any)[name])
      .filter((fn) => typeof fn === 'function')
      .map((fn) => ({
        path: Reflect.getMetadata(PATH_METADATA, fn),
        method: Reflect.getMetadata(METHOD_METADATA, fn),
      }))
      .filter((r) => r.path !== undefined);

    expect(routes).toContainEqual({
      path: 'login',
      method: RequestMethod.POST,
    });
    expect(routes.map((r) => r.path)).not.toContain('register');
  });
});

describe('LoginDto', () => {
  it('trims and lowercases the email before validating it', async () => {
    const dto = plainToInstance(LoginDto, {
      email: '  Asha@Example.COM ',
      password: 'pw',
    });
    expect(dto.email).toBe('asha@example.com');
    expect(await validate(dto)).toHaveLength(0);
  });
});
