import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { WhatsappService, WhatsappWebhookPayload } from './whatsapp.service';
import { WhatsappMessage } from '../../schemas/whatsapp-message.schema';

// [filter, update, options] as passed to Model.updateOne.
type UpdateCall = [
  Record<string, unknown>,
  { $setOnInsert: Record<string, string | boolean | Date | undefined> },
  Record<string, unknown>,
];

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

// A realistic inbound text payload, trimmed to the fields we read.
const textPayload: WhatsappWebhookPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '918000000000',
              phone_number_id: '106540352242922',
            },
            contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
            messages: [
              {
                id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgU',
                from: '919876543210',
                timestamp: '1758000000',
                type: 'text',
                text: { body: 'Do you ship to Hyderabad?' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('WhatsappService', () => {
  let service: WhatsappService;
  let updateOne: jest.Mock;

  beforeEach(async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        {
          provide: getModelToken(WhatsappMessage.name),
          useValue: { updateOne },
        },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
  });

  afterEach(() => {
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
  });

  describe('verifySubscription', () => {
    it('echoes the challenge when the token matches', () => {
      expect(
        service.verifySubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        }),
      ).toBe('1158201444');
    });

    it('rejects a wrong verify token', () => {
      expect(() =>
        service.verifySubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': '1158201444',
        }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertValidSignature', () => {
    const body = Buffer.from(JSON.stringify(textPayload));
    const sign = (buf: Buffer) =>
      'sha256=' + createHmac('sha256', APP_SECRET).update(buf).digest('hex');

    it('accepts a correctly signed body', () => {
      expect(() =>
        service.assertValidSignature(body, sign(body)),
      ).not.toThrow();
    });

    it('rejects a body that was tampered with after signing', () => {
      const signature = sign(body);
      const tampered = Buffer.from(
        JSON.stringify({ ...textPayload, entry: [] }),
      );
      expect(() => service.assertValidSignature(tampered, signature)).toThrow(
        ForbiddenException,
      );
    });

    it('rejects a missing signature header', () => {
      expect(() => service.assertValidSignature(body, undefined)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('handleEvent', () => {
    it('stores an inbound text message keyed on the WhatsApp id', async () => {
      await service.handleEvent(textPayload);

      expect(updateOne).toHaveBeenCalledTimes(1);
      const [filter, update, options] = updateOne.mock.calls[0] as UpdateCall;
      expect(filter).toEqual({
        waMessageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgU',
      });
      expect(options).toEqual({ upsert: true });
      expect(update.$setOnInsert).toMatchObject({
        from: '919876543210',
        profileName: 'Asha',
        type: 'text',
        text: 'Do you ship to Hyderabad?',
        phoneNumberId: '106540352242922',
        handled: false,
      });
      expect(update.$setOnInsert.sentAt).toEqual(new Date(1758000000 * 1000));
    });

    it('reads the tapped title out of an interactive reply', async () => {
      await service.handleEvent({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: '106540352242922' },
                  messages: [
                    {
                      id: 'wamid.interactive',
                      from: '919876543210',
                      timestamp: '1758000100',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: 'track', title: 'Track my order' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const [, update] = updateOne.mock.calls[0] as UpdateCall;
      expect(update.$setOnInsert).toMatchObject({
        type: 'interactive',
        text: 'Track my order',
      });
    });

    it('ignores payloads for other objects', async () => {
      await service.handleEvent({ object: 'page', entry: [] });
      expect(updateOne).not.toHaveBeenCalled();
    });

    it('swallows a storage failure so Meta still gets its 200', async () => {
      updateOne.mockRejectedValueOnce(new Error('mongo down'));
      await expect(service.handleEvent(textPayload)).resolves.toBeUndefined();
    });
  });
});
