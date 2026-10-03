import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { WhatsappInboxService, phoneKey } from './whatsapp-inbox.service';

const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    populate: () => q,
    sort: () => q,
    lean: () => q,
  };
  return q;
};

const T1 = new Types.ObjectId();
const T2 = new Types.ObjectId();
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min));

// Two tribes; owner of T1 has a chat; one number is a member of both tribes.
const tribes = [
  {
    _id: T1,
    brand: 'Fit Tribe',
    userId: { name: 'Asha', phoneNumber: '98765 00001' },
  },
  {
    _id: T2,
    brand: 'Run Club',
    userId: { name: 'Ravi', phoneNumber: '9876500009' },
  },
];
const members = [
  { _id: 'm1', coachId: T1, phone: '9000000001', name: 'Kiran' },
  { _id: 'm2', coachId: T1, phone: '9000000002', name: 'Meena' },
  { _id: 'm3', coachId: T2, phone: '9000000002', name: 'Meena' },
];
const conversations = [
  { contact: '919876500001', unreadCount: 1, updatedAt: at(1) }, // T1 owner
  { contact: '919000000001', unreadCount: 2, updatedAt: at(5) }, // T1 member
  { contact: '919000000002', unreadCount: 0, updatedAt: at(9) }, // T1 + T2 member
  { contact: '919111111111', unreadCount: 3, updatedAt: at(7) }, // nobody's
];

function setup() {
  const tribeModel: any = {
    find: jest.fn(() => query(tribes)),
    findById: jest.fn((id: any) =>
      query(tribes.find((t) => String(t._id) === String(id)) ?? null),
    ),
  };
  const memberModel: any = {
    find: jest.fn((filter?: any) =>
      query(
        filter?.coachId
          ? members.filter((m) => String(m.coachId) === String(filter.coachId))
          : members,
      ),
    ),
  };
  const conversationModel: any = {
    find: jest.fn((filter?: any) =>
      query(
        filter?.contact instanceof RegExp
          ? conversations.filter((c) => filter.contact.test(c.contact))
          : conversations,
      ),
    ),
  };
  const whatsapp: any = {
    presentConversation: (c: any) => ({ ...c, windowOpen: false }),
  };
  return new WhatsappInboxService(
    conversationModel,
    memberModel,
    tribeModel,
    whatsapp,
  );
}

describe('phoneKey', () => {
  it('reduces WhatsApp ids and formatted numbers to the same 10 digits', () => {
    expect(phoneKey('919876543210')).toBe('9876543210');
    expect(phoneKey('+91 98765 43210')).toBe('9876543210');
    expect(phoneKey(undefined)).toBe('');
  });
});

describe('WhatsappInboxService.summary', () => {
  it('counts chats and unread per tribe, newest first, and the rest as other', async () => {
    const { tribes: rows, other } = await setup().summary();
    const t1 = rows.find((r) => r._id === String(T1))!;
    const t2 = rows.find((r) => r._id === String(T2))!;
    // Owner + two members; the shared number counts for both tribes.
    expect(t1).toMatchObject({
      name: 'Asha',
      ownerPhone: '9876500001',
      chatCount: 3,
      unreadCount: 3,
    });
    expect(t2).toMatchObject({
      ownerPhone: '9876500009',
      chatCount: 1,
      unreadCount: 0,
    });
    expect(other).toEqual({ chatCount: 1, unreadCount: 3 });
    // Both tribes' newest chat is the shared one (at 9); ties fall back to name.
    expect(rows.map((r) => r.name)).toEqual(['Asha', 'Ravi']);
  });
});

describe('WhatsappInboxService.tribe', () => {
  it('returns the owner with their chat, then member chats newest first', async () => {
    const res = await setup().tribe(String(T1));
    expect(res.owner).toMatchObject({
      name: 'Asha',
      phone: '9876500001',
      contact: '919876500001',
    });
    expect(res.owner.conversation).toMatchObject({ contact: '919876500001' });
    expect(res.members.map((m) => m.member.name)).toEqual(['Meena', 'Kiran']);
  });

  it('gives an owner without a chat a contact to start one, and lists no member twice', async () => {
    const res = await setup().tribe(String(T2));
    expect(res.owner).toMatchObject({
      phone: '9876500009',
      contact: '919876500009',
      conversation: null,
    });
    expect(res.members).toHaveLength(1);
  });

  it('404s an unknown or malformed tribe', async () => {
    const svc = setup();
    await expect(svc.tribe('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.tribe(String(new Types.ObjectId())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WhatsappInboxService.other', () => {
  it('lists only chats whose number no owner or member has', async () => {
    const res = await setup().other();
    expect(res.map((c: any) => c.contact)).toEqual(['919111111111']);
  });
});
