import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

const CONTACT = '919876543210';
const pdf = {
  buffer: Buffer.from('%PDF-1.4'),
  mimetype: 'application/pdf',
  originalname: 'Invoice.pdf',
  size: 8,
};

function setup(
  conversation: unknown = { contact: CONTACT, lastInboundAt: new Date() },
) {
  const messageModel = { create: jest.fn(async (doc: any) => doc) };
  const conversationModel = {
    findOne: jest.fn().mockResolvedValue(conversation),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const api = {
    uploadMedia: jest.fn().mockResolvedValue('987654321'),
    sendMedia: jest.fn().mockResolvedValue({ waMessageId: 'wamid.media1' }),
  };
  const service = new WhatsappService(
    messageModel as any,
    conversationModel as any,
    {} as any,
    api as any,
  );
  return { service, messageModel, conversationModel, api };
}

describe('WhatsappService.replyWithMedia', () => {
  it('uploads, sends and records a document with its caption', async () => {
    const { service, api, messageModel, conversationModel } = setup();
    const saved: any = await service.replyWithMedia(
      CONTACT,
      pdf,
      '  Your invoice  ',
    );
    expect(api.uploadMedia).toHaveBeenCalledWith(
      pdf.buffer,
      'application/pdf',
      'Invoice.pdf',
    );
    expect(api.sendMedia).toHaveBeenCalledWith(
      CONTACT,
      'document',
      '987654321',
      {
        caption: 'Your invoice',
        filename: 'Invoice.pdf',
      },
    );
    expect(saved).toMatchObject({
      waMessageId: 'wamid.media1',
      type: 'document',
      mediaId: '987654321',
      mimeType: 'application/pdf',
      text: 'Your invoice',
      sendStatus: 'SENT',
      direction: 'OUTBOUND',
    });
    expect(messageModel.create).toHaveBeenCalledTimes(1);
    expect(
      conversationModel.updateOne.mock.calls[0][1].$set.lastMessagePreview,
    ).toBe('📎 Your invoice');
  });

  it('shows a document by its name when there is no caption; audio drops the caption', async () => {
    let ctx = setup();
    const doc: any = await ctx.service.replyWithMedia(CONTACT, pdf);
    expect(doc.text).toBe('Invoice.pdf');

    ctx = setup();
    await ctx.service.replyWithMedia(
      CONTACT,
      {
        buffer: Buffer.from('x'),
        mimetype: 'audio/mpeg',
        originalname: 'note.mp3',
        size: 1,
      },
      'ignored',
    );
    expect(ctx.api.sendMedia.mock.calls[0][3].caption).toBeUndefined();
  });

  it('refuses when the 24-hour window is closed or the conversation is unknown', async () => {
    const closed = setup({
      contact: CONTACT,
      lastInboundAt: new Date(Date.now() - 25 * 3600e3),
    });
    await expect(closed.service.replyWithMedia(CONTACT, pdf)).rejects.toThrow(
      '24-hour reply window',
    );
    expect(closed.api.uploadMedia).not.toHaveBeenCalled();

    const none = setup(null);
    await expect(
      none.service.replyWithMedia(CONTACT, pdf),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a file type WhatsApp cannot send, before uploading', async () => {
    const { service, api } = setup();
    await expect(
      service.replyWithMedia(CONTACT, {
        buffer: Buffer.from('x'),
        mimetype: 'application/zip',
        originalname: 'a.zip',
        size: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });

  it('records a failed send (with the reason) and rethrows', async () => {
    const { service, api, messageModel } = setup();
    api.sendMedia.mockRejectedValue(
      new BadRequestException('Recipient phone number not in allowed list'),
    );
    await expect(service.replyWithMedia(CONTACT, pdf)).rejects.toThrow(
      'not in allowed list',
    );
    const row: any = messageModel.create.mock.calls[0][0];
    expect(row).toMatchObject({
      sendStatus: 'FAILED',
      mediaId: '987654321',
      type: 'document',
    });
    expect(row.errorMessage).toBeTruthy();
  });
});

describe('WhatsappService.unreadSummary', () => {
  const svc = (rows: unknown[]) => {
    const aggregate = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue(rows),
    }));
    return {
      aggregate,
      service: new WhatsappService(
        {} as any,
        { aggregate } as any,
        {} as any,
        {} as any,
      ),
    };
  };

  it('sums chats and messages with unread messages', async () => {
    const { service, aggregate } = svc([{ chats: 2, messages: 5 }]);
    await expect(service.unreadSummary()).resolves.toEqual({
      chats: 2,
      messages: 5,
    });
    expect((aggregate.mock.calls[0] as any)[0][0]).toEqual({
      $match: { unreadCount: { $gt: 0 } },
    });
  });

  it('is zero when nothing is unread', async () => {
    await expect(svc([]).service.unreadSummary()).resolves.toEqual({
      chats: 0,
      messages: 0,
    });
  });
});
