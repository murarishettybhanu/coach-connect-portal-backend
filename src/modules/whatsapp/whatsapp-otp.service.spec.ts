import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { WhatsappOtpService } from './whatsapp-otp.service';
import { WhatsappService } from './whatsapp.service';
import { WhatsappApiService } from './whatsapp-api.service';
import { WhatsappOtp } from '../../schemas/whatsapp-otp.schema';

describe('WhatsappOtpService', () => {
  let service: WhatsappOtpService;
  let findOne: jest.Mock;
  let updateOne: jest.Mock;
  let sendTemplateTo: jest.Mock;
  const jwt = new JwtService({ secret: 'test-secret' });

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(null);
    updateOne = jest.fn().mockResolvedValue({});
    sendTemplateTo = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappOtpService,
        {
          provide: getModelToken(WhatsappOtp.name),
          useValue: { findOne, updateOne },
        },
        {
          provide: WhatsappService,
          useValue: {
            sendTemplateTo,
            // The real implementation; number handling is tested there.
            normalizeContact: (raw: string) => {
              const digits = raw.replace(/\D/g, '');
              return digits.length === 10 ? `91${digits}` : digits;
            },
          },
        },
        {
          provide: WhatsappApiService,
          useValue: {
            canSend: true,
            getTemplateById: jest.fn().mockResolvedValue({
              name: 'login_code',
              language: 'en',
              status: 'APPROVED',
            }),
          },
        },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = module.get<WhatsappOtpService>(WhatsappOtpService);
  });

  describe('request', () => {
    it('sends a six-digit code and stores only its hash', async () => {
      await service.request('9876543210');

      const [to, input] = sendTemplateTo.mock.calls[0] as [
        string,
        { parameters: string[] },
      ];
      expect(to).toBe('919876543210');
      const code = input.parameters[0];
      expect(code).toMatch(/^\d{6}$/);

      const [, update] = updateOne.mock.calls[0] as [
        unknown,
        { $set: { codeHash: string } },
      ];
      // The code itself must never be persisted.
      expect(update.$set.codeHash).not.toBe(code);
      expect(await bcrypt.compare(code, update.$set.codeHash)).toBe(true);
    });

    it('refuses a number that cannot be an Indian mobile, before spending a message', async () => {
      // Starts with 5 — a typo or a made-up number. Meta would still accept
      // the send and bill for it, so this has to be caught here.
      await expect(service.request('5876543210')).rejects.toThrow(
        BadRequestException,
      );
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });

    it('refuses a resend inside the cooldown', async () => {
      findOne.mockResolvedValueOnce({
        contact: '919876543210',
        lastSentAt: new Date(Date.now() - 5_000),
      });

      await expect(service.request('9876543210')).rejects.toThrow(
        BadRequestException,
      );
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const record = async (overrides: Record<string, unknown> = {}) => ({
      contact: '919876543210',
      codeHash: await bcrypt.hash('123456', 10),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
      ...overrides,
    });

    it('returns a proof token tied to the number', async () => {
      findOne.mockResolvedValueOnce(await record());

      const result = await service.verify('9876543210', '123456');
      expect(result.verified).toBe(true);
      expect(service.checkProof(result.otpToken, '9876543210')).toEqual({
        ok: true,
      });
    });

    it('will not accept that token for a different number', async () => {
      findOne.mockResolvedValueOnce(await record());

      const { otpToken } = await service.verify('9876543210', '123456');
      expect(service.checkProof(otpToken, '9123456789')).toEqual({
        ok: false,
        reason: 'number-mismatch',
      });
    });

    it('counts a wrong code against the attempt limit', async () => {
      findOne.mockResolvedValueOnce(await record());

      await expect(service.verify('9876543210', '000000')).rejects.toThrow(
        BadRequestException,
      );
      const [, update] = updateOne.mock.calls[0] as [
        unknown,
        { $inc: unknown },
      ];
      expect(update.$inc).toEqual({ attempts: 1 });
    });

    it('rejects an expired code', async () => {
      findOne.mockResolvedValueOnce(
        await record({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.verify('9876543210', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects once the attempt limit is spent, even with the right code', async () => {
      findOne.mockResolvedValueOnce(await record({ attempts: 5 }));
      await expect(service.verify('9876543210', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('gives the same message whatever went wrong', async () => {
      findOne.mockResolvedValueOnce(null);
      const unknownNumber = await service
        .verify('9876543210', '123456')
        .catch((e: Error) => e.message);

      findOne.mockResolvedValueOnce(await record());
      const wrongCode = await service
        .verify('9876543210', '000000')
        .catch((e: Error) => e.message);

      // Distinguishing them would let a caller enumerate numbers.
      expect(unknownNumber).toBe(wrongCode);
    });
  });

  describe('checkProof', () => {
    it('rejects a token this service did not issue', () => {
      expect(service.checkProof('nonsense', '9876543210')).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('rejects a valid JWT that was not issued for verification', () => {
      const other = jwt.sign({ sub: '919876543210', purpose: 'login' });
      expect(service.checkProof(other, '9876543210')).toEqual({
        ok: false,
        reason: 'wrong-token',
      });
    });
  });
});
