import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { WhatsappService, WhatsappWebhookPayload } from './whatsapp.service';
import { WhatsappMessage } from '../../schemas/whatsapp-message.schema';
import { WhatsappConversation } from '../../schemas/whatsapp-conversation.schema';
import { WhatsappSetting } from '../../schemas/whatsapp-setting.schema';
import { WhatsappApiService } from './whatsapp-api.service';

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
  let conversationUpdateOne: jest.Mock;
  let create: jest.Mock;
  let findOneAndUpdate: jest.Mock;
  let sendText: jest.Mock;
  let sendTemplate: jest.Mock;
  let listTemplates: jest.Mock;
  let settings: Record<string, unknown>;

  beforeEach(async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    conversationUpdateOne = jest.fn().mockResolvedValue({});
    create = jest.fn().mockResolvedValue({});
    // Returning a document means this caller won the acknowledgement claim.
    findOneAndUpdate = jest.fn().mockResolvedValue({ contact: '919876543210' });
    sendText = jest.fn().mockResolvedValue({ waMessageId: 'wamid.out1' });
    sendTemplate = jest.fn().mockResolvedValue({ waMessageId: 'wamid.tpl1' });
    listTemplates = jest.fn().mockResolvedValue([
      {
        id: '1',
        name: 'order_dispatched',
        language: 'en',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [
          { type: 'BODY', text: 'Hi {{1}}, order {{2}} has shipped.' },
        ],
      },
      {
        id: '2',
        name: 'login_code',
        language: 'en',
        category: 'AUTHENTICATION',
        status: 'APPROVED',
        // Meta generates authentication copy, so no body text comes back.
        components: [{ type: 'BODY' }],
      },
    ]);
    settings = {
      autoReplyEnabled: true,
      acknowledgementText: 'Thanks for messaging Tribe Merchandise.',
      afterHoursText: "We're away — back in the morning.",
      businessHoursEnabled: false,
      openTime: '09:00',
      closeTime: '18:00',
      openDays: [1, 2, 3, 4, 5, 6],
      timezone: 'Asia/Kolkata',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        {
          provide: getModelToken(WhatsappMessage.name),
          useValue: { updateOne, create },
        },
        {
          provide: getModelToken(WhatsappConversation.name),
          useValue: { updateOne: conversationUpdateOne, findOneAndUpdate },
        },
        {
          provide: getModelToken(WhatsappSetting.name),
          // getSettings() reads the singleton row; the tests mutate `settings`.
          useValue: { findOne: jest.fn(() => Promise.resolve(settings)) },
        },
        {
          provide: WhatsappApiService,
          useValue: { sendText, sendTemplate, listTemplates, canSend: true },
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

  describe('sendTemplateTo', () => {
    it('records the rendered body so the thread reads like a conversation', async () => {
      await service.sendTemplateTo('9876543210', {
        name: 'order_dispatched',
        language: 'en',
        parameters: ['Asha', 'TM-10482'],
      });

      const [, input] = sendTemplate.mock.calls[0] as [
        string,
        { authentication?: boolean },
      ];
      expect(input.authentication).toBe(false);

      const created = (create.mock.calls[0] as [Record<string, unknown>])[0];
      expect(created.text).toBe('Hi Asha, order TM-10482 has shipped.');
      // The typed-in number reaches Meta as a wa_id.
      expect(created.contact).toBe('919876543210');
    });

    it('flags an authentication template so the code also rides in the OTP button', async () => {
      await service.sendTemplateTo('919876543210', {
        name: 'login_code',
        language: 'en',
        parameters: ['123456'],
      });

      const [, input] = sendTemplate.mock.calls[0] as [
        string,
        { authentication?: boolean },
      ];
      expect(input.authentication).toBe(true);

      // No body text from Meta, so the thread falls back to the standard wording.
      const created = (create.mock.calls[0] as [Record<string, unknown>])[0];
      expect(created.text).toBe('123456 is your verification code.');
    });

    it('still sends when the template lookup fails', async () => {
      listTemplates.mockRejectedValueOnce(new Error('graph down'));

      await service.sendTemplateTo('919876543210', {
        name: 'order_dispatched',
        language: 'en',
      });

      expect(sendTemplate).toHaveBeenCalledTimes(1);
      const created = (create.mock.calls[0] as [Record<string, unknown>])[0];
      expect(created.text).toBe('[template: order_dispatched]');
    });
  });

  describe('normalizeContact', () => {
    it('adds the Indian country code to a bare 10-digit number', () => {
      expect(service.normalizeContact('9876543210')).toBe('919876543210');
    });

    it('strips punctuation, spaces and the leading +', () => {
      expect(service.normalizeContact('+91 98765-43210')).toBe('919876543210');
    });

    it('drops the domestic trunk 0', () => {
      expect(service.normalizeContact('09876543210')).toBe('919876543210');
    });

    it('leaves a number that already has a country code alone', () => {
      expect(service.normalizeContact('14155552671')).toBe('14155552671');
    });

    it('rejects something too short to be a phone number', () => {
      expect(() => service.normalizeContact('12345')).toThrow(
        BadRequestException,
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

    it('sends one acknowledgement when the claim is won', async () => {
      await service.handleEvent(textPayload);

      expect(sendText).toHaveBeenCalledTimes(1);
      const [to, body] = sendText.mock.calls[0] as [string, string];
      expect(to).toBe('919876543210');
      expect(body).toBe(settings.acknowledgementText);
    });

    it('stays silent when the auto-reply is switched off', async () => {
      settings.autoReplyEnabled = false;
      await service.handleEvent(textPayload);
      expect(sendText).not.toHaveBeenCalled();
    });

    it('uses the after-hours text when the business is closed', async () => {
      // No open days at all, so every moment falls outside business hours.
      settings.businessHoursEnabled = true;
      settings.openDays = [];

      await service.handleEvent(textPayload);

      const [, body] = sendText.mock.calls[0] as [string, string];
      expect(body).toBe(settings.afterHoursText);
    });

    it('stays silent when another delivery already claimed the acknowledgement', async () => {
      // No document back = the conditional update matched nothing = already sent.
      findOneAndUpdate.mockResolvedValueOnce(null);
      await service.handleEvent(textPayload);
      expect(sendText).not.toHaveBeenCalled();
    });

    it('does not acknowledge a redelivered message', async () => {
      updateOne.mockResolvedValueOnce({ upsertedCount: 0 });
      await service.handleEvent(textPayload);
      expect(sendText).not.toHaveBeenCalled();
    });

    it('releases the claim when the acknowledgement fails to send', async () => {
      sendText.mockRejectedValueOnce(new Error('graph down'));
      await service.handleEvent(textPayload);

      // Last conversation write clears ackSentAt so the next message retries.
      const calls = conversationUpdateOne.mock.calls as Array<
        [unknown, Record<string, unknown>]
      >;
      expect(calls[calls.length - 1][1]).toEqual({ $unset: { ackSentAt: 1 } });
    });

    it('swallows a storage failure so Meta still gets its 200', async () => {
      updateOne.mockRejectedValueOnce(new Error('mongo down'));
      await expect(service.handleEvent(textPayload)).resolves.toBeUndefined();
    });
  });
});
