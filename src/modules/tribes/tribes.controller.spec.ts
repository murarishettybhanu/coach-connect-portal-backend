import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TribesController } from './tribes.controller';
import { UpdateTribeDto } from './dto/update-tribe.dto';
import { UserRole } from '../../schemas/user.schema';

function setup() {
  const tribesService = {
    findIdByUserId: jest.fn().mockResolvedValue('tribe1'),
    update: jest.fn().mockResolvedValue({}),
  };
  return {
    controller: new TribesController(tribesService as any),
    tribesService,
  };
}

describe('TribesController.update', () => {
  const tribeReq = { user: { role: UserRole.TRIBE } };

  it('refuses another tribe’s record', async () => {
    const { controller } = setup();
    await expect(
      controller.update('tribe2', { brand: 'x' }, tribeReq, 'user1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('drops admin-only fields for a tribe caller', async () => {
    const { controller, tribesService } = setup();
    await controller.update(
      'tribe1',
      {
        brand: 'B',
        username: 'new',
        isActive: false,
        name: 'N',
        email: 'e@x.com',
        bankingDetails: { ifsc: 'X' },
      },
      tribeReq,
      'user1',
    );
    expect(tribesService.update).toHaveBeenCalledWith('tribe1', {
      brand: 'B',
      bankingDetails: { ifsc: 'X' },
    });
  });

  it('passes everything through for an admin', async () => {
    const { controller, tribesService } = setup();
    const dto = { username: 'new', isActive: false };
    await controller.update(
      'tribe2',
      dto,
      { user: { role: UserRole.ADMIN } },
      'a1',
    );
    expect(tribesService.update).toHaveBeenCalledWith('tribe2', dto);
  });
});

describe('UpdateTribeDto', () => {
  const errorsFor = (payload: any) =>
    validate(plainToInstance(UpdateTribeDto, payload) as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('rejects operators and server-managed fields', async () => {
    expect(
      (await errorsFor({ $set: { walletBalance: 1 } })).length,
    ).toBeGreaterThan(0);
    expect((await errorsFor({ walletBalance: 1 })).length).toBeGreaterThan(0);
    expect(
      (await errorsFor({ bankingDetails: { $where: '1' } })).length,
    ).toBeGreaterThan(0);
  });

  it('accepts the branding, wallet and admin edit payloads', async () => {
    expect(
      await errorsFor({
        brand: 'B',
        tagline: '',
        bio: '',
        contactEmail: '',
        profileImage: '',
        logoUrl: '',
        socialLinks: { instagram: '', twitter: '', youtube: '', linkedin: '' },
      }),
    ).toEqual([]);
    expect(
      await errorsFor({
        bankingDetails: {
          holderName: 'A',
          accountNumber: '1',
          ifsc: 'X',
          upiId: '',
        },
      }),
    ).toEqual([]);
    expect(
      await errorsFor({
        name: 'A',
        email: 'a@b.com',
        phoneNumber: '',
        username: 'a',
        brand: 'B',
      }),
    ).toEqual([]);
  });
});
