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
  let deleteOne: jest.Mock;
  let findOneAndUpdate: jest.Mock;
  let sendTemplateTo: jest.Mock;
  const jwt = new JwtService({ secret: 'test-secret' });

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(null);
    updateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    deleteOne = jest.fn().mockResolvedValue({});
    findOneAndUpdate = jest.fn().mockResolvedValue(null);
    sendTemplateTo = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappOtpService,
        {
          provide: getModelToken(WhatsappOtp.name),
          useValue: { findOne, updateOne, deleteOne, findOneAndUpdate },
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
              category: 'AUTHENTICATION',
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

    it('passes the resolved template along so the send needs no second lookup', async () => {
      await service.request('9876543210');
      const [, , opts] = sendTemplateTo.mock.calls[0] as [
        string,
        unknown,
        { template?: { category?: string } },
      ];
      expect(opts.template?.category).toBe('AUTHENTICATION');
    });

    const sentAgo = (...minutes: number[]) =>
      minutes.map((m) => new Date(Date.now() - m * 60_000));

    it('caps sends per number per hour', async () => {
      findOne.mockResolvedValueOnce({
        contact: '919876543210',
        lastSentAt: new Date(Date.now() - 2 * 60_000),
        sendLog: sentAgo(50, 40, 30, 20, 2),
      });
      await expect(service.request('9876543210')).rejects.toThrow(
        /try again in an hour/i,
      );
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });

    it('caps sends per number per day', async () => {
      findOne.mockResolvedValueOnce({
        contact: '919876543210',
        lastSentAt: new Date(Date.now() - 120 * 60_000),
        sendLog: sentAgo(1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 120),
      });
      await expect(service.request('9876543210')).rejects.toThrow(
        /try again tomorrow/i,
      );
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });

    it('forgets sends older than a day', async () => {
      findOne.mockResolvedValueOnce({
        contact: '919876543210',
        lastSentAt: new Date(Date.now() - 1500 * 60_000),
        sendLog: sentAgo(
          1500,
          1490,
          1480,
          1470,
          1460,
          1450,
          1445,
          1442,
          1441,
          1500,
        ),
      });
      await service.request('9876543210');

      expect(sendTemplateTo).toHaveBeenCalledTimes(1);
      const [, update] = updateOne.mock.calls[0] as [
        unknown,
        { $set: { sendLog: Date[] } },
      ];
      // Only the send just made survives the prune.
      expect(update.$set.sendLog).toHaveLength(1);
    });

    it('loses a race with a concurrent request instead of sending twice', async () => {
      const lastSentAt = new Date(Date.now() - 5 * 60_000);
      findOne.mockResolvedValueOnce({
        contact: '919876543210',
        lastSentAt,
        sendLog: [],
      });
      // The other request rewrote the row between our read and our write.
      updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

      await expect(service.request('9876543210')).rejects.toThrow(
        /please wait/i,
      );
      const [filter] = updateOne.mock.calls[0] as [Record<string, unknown>];
      expect(filter).toEqual({ contact: '919876543210', lastSentAt });
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });

    it('treats a duplicate key on a first-ever send as the same race', async () => {
      updateOne.mockRejectedValueOnce(
        Object.assign(new Error('E11000'), { code: 11000 }),
      );
      await expect(service.request('9876543210')).rejects.toThrow(
        /please wait/i,
      );
      expect(sendTemplateTo).not.toHaveBeenCalled();
    });

    it('restores the previous code when the send fails', async () => {
      const previous = {
        contact: '919876543210',
        codeHash: 'previous-hash',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        lastSentAt: new Date(Date.now() - 5 * 60_000),
        attempts: 2,
        sendLog: sentAgo(5),
      };
      findOne.mockResolvedValueOnce(previous);
      sendTemplateTo.mockRejectedValueOnce(new Error('graph down'));

      await expect(service.request('9876543210')).rejects.toThrow('graph down');

      const [, written] = updateOne.mock.calls[0] as [
        unknown,
        { $set: { lastSentAt: Date } },
      ];
      const [filter, restored] = updateOne.mock.calls[1] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      // Only undoes our own write, not a later request's.
      expect(filter).toEqual({
        contact: '919876543210',
        lastSentAt: written.$set.lastSentAt,
      });
      expect(restored.$set).toMatchObject({
        codeHash: 'previous-hash',
        expiresAt: previous.expiresAt,
        lastSentAt: previous.lastSentAt,
        attempts: 2,
      });
    });

    it('removes a first-ever code whose send failed', async () => {
      sendTemplateTo.mockRejectedValueOnce(new Error('graph down'));
      await expect(service.request('9876543210')).rejects.toThrow('graph down');
      expect(deleteOne).toHaveBeenCalledWith(
        expect.objectContaining({ contact: '919876543210' }),
      );
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
      findOneAndUpdate.mockResolvedValueOnce(await record({ attempts: 1 }));

      const result = await service.verify('9876543210', '123456');
      expect(result.verified).toBe(true);
      expect(service.checkProof(result.otpToken, '9876543210')).toEqual({
        ok: true,
      });
    });

    it('will not accept that token for a different number', async () => {
      findOneAndUpdate.mockResolvedValueOnce(await record({ attempts: 1 }));

      const { otpToken } = await service.verify('9876543210', '123456');
      expect(service.checkProof(otpToken, '9123456789')).toEqual({
        ok: false,
        reason: 'number-mismatch',
      });
    });

    it('reserves the attempt atomically before comparing the code', async () => {
      findOneAndUpdate.mockResolvedValueOnce(await record({ attempts: 1 }));

      await expect(service.verify('9876543210', '000000')).rejects.toThrow(
        BadRequestException,
      );
      const [filter, update] = findOneAndUpdate.mock.calls[0] as [
        {
          contact: string;
          attempts: { $lt: number };
          expiresAt: { $gt: Date };
        },
        { $inc: unknown },
      ];
      // The guard lives in the filter, so parallel guesses can't all pass it.
      expect(filter.contact).toBe('919876543210');
      expect(filter.attempts).toEqual({ $lt: 5 });
      expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
      expect(update).toEqual({ $inc: { attempts: 1 } });
      // A wrong code consumes nothing.
      expect(updateOne).not.toHaveBeenCalled();
    });

    it('rejects when no attempt could be reserved (expired, spent or unknown)', async () => {
      // The filter matched nothing: expired, attempts used up, or no code.
      findOneAndUpdate.mockResolvedValueOnce(null);
      await expect(service.verify('9876543210', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('consumes the code conditionally so it works once under a race', async () => {
      const rec = await record({ attempts: 1 });
      findOneAndUpdate.mockResolvedValueOnce(rec);
      // A simultaneous correct submission consumed it first.
      updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

      await expect(service.verify('9876543210', '123456')).rejects.toThrow(
        BadRequestException,
      );
      const [filter] = updateOne.mock.calls[0] as [Record<string, unknown>];
      expect(filter).toMatchObject({
        contact: '919876543210',
        codeHash: rec.codeHash,
        verifiedAt: { $exists: false },
      });
    });

    it('gives the same message whatever went wrong', async () => {
      findOneAndUpdate.mockResolvedValueOnce(null);
      const unknownNumber = await service
        .verify('9876543210', '123456')
        .catch((e: Error) => e.message);

      findOneAndUpdate.mockResolvedValueOnce(await record({ attempts: 1 }));
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

    it('rejects a token with the right purpose but no proof audience', () => {
      // Shape of a proof minted before audiences — or forged from a login.
      const noAudience = jwt.sign({
        sub: '919876543210',
        purpose: 'whatsapp-otp',
      });
      expect(service.checkProof(noAudience, '9876543210')).toEqual({
        ok: false,
        reason: 'wrong-token',
      });
    });

    it('issues proofs with the otp-proof audience', async () => {
      findOneAndUpdate.mockResolvedValueOnce({
        contact: '919876543210',
        codeHash: await bcrypt.hash('123456', 10),
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 1,
      });
      const { otpToken } = await service.verify('9876543210', '123456');
      expect(jwt.decode(otpToken)).toMatchObject({
        aud: 'otp-proof',
        purpose: 'whatsapp-otp',
      });
    });
  });
});
