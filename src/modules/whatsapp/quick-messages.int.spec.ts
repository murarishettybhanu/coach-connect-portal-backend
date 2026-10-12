import mongoose, { Connection, Types } from 'mongoose';
import { QuickMessagesService } from './quick-messages.service';
import { WhatsappConversationSchema } from '../../schemas/whatsapp-conversation.schema';
import { TribeMemberSchema } from '../../schemas/tribe-member.schema';
import { TribeSchema } from '../../schemas/tribe.schema';
import { OrderSchema } from '../../schemas/order.schema';
import { UserSchema } from '../../schemas/user.schema';
import { CampaignSchema } from '../../schemas/campaign.schema';

// Real MongoDB: the context joins conversations, tribes (owner phones via
// populate), members and orders by phone. Skipped without MONGO_TEST_URI.
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('QuickMessagesService (real Mongo)', () => {
  let conn: Connection;
  let svc: QuickMessagesService;
  const sendQuick = jest.fn(async (..._a: any[]) => ({ ok: true }));
  const T1 = new Types.ObjectId();
  const T2 = new Types.ObjectId();
  const OWNER = new Types.ObjectId();
  const CAMP = new Types.ObjectId();
  const MEMBER = '919876543210';
  const OWNER_WA = '919111111111';
  const STRANGER = '919222222222';

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_quickmsgtest' })
      .asPromise();
    const m = (n: string, s: any) => conn.model(n, s);
    const conv = m('WhatsappConversation', WhatsappConversationSchema);
    const member = m('TribeMember', TribeMemberSchema);
    const tribe = m('Tribe', TribeSchema);
    const order = m('Order', OrderSchema);
    m('User', UserSchema);
    m('Campaign', CampaignSchema);
    await conn
      .collection('users')
      .insertOne({
        _id: OWNER,
        name: 'Ravi Owner',
        phoneNumber: '9111111111',
        email: 'o@x',
        role: 'TRIBE',
      });
    await tribe.collection.insertMany([
      {
        _id: T1,
        userId: OWNER,
        brand: 'RV Life Coaching',
        username: 'RV Life Coaching',
      },
      {
        _id: T2,
        userId: new Types.ObjectId(),
        brand: 'Other Tribe',
        username: 'other',
      },
    ]);
    await member.collection.insertMany([
      { coachId: T1, phone: '9876543210', name: 'asha KUMAR' },
      { coachId: T2, phone: '9876543210', name: 'Asha K' },
    ]);
    await conn
      .collection('campaigns')
      .insertOne({ _id: CAMP, name: 'Platinum Kit Telugu' });
    await order.collection.insertMany([
      {
        coachId: T1,
        campaignId: CAMP,
        status: 'DISPATCHED',
        approvalStatus: 'APPROVED',
        trackingNumber: 'CA182468665IN',
        isDeleted: false,
        shippingAddress: { fullName: 'Asha Kumar', phone: '9876543210' },
        createdAt: new Date('2026-10-01'),
      },
      {
        coachId: T2,
        status: 'NEW',
        approvalStatus: 'PENDING',
        isDeleted: false,
        shippingAddress: { fullName: 'Asha', phone: '9876543210' },
        createdAt: new Date('2026-10-05'),
      },
      {
        coachId: T1,
        status: 'NEW',
        approvalStatus: 'REJECTED',
        isDeleted: false,
        shippingAddress: { phone: '9876543210' },
        createdAt: new Date('2026-10-09'),
      },
    ]);
    const now = new Date();
    await conv.collection.insertMany([
      { contact: MEMBER, profileName: 'Asha 🌸', lastInboundAt: now },
      { contact: OWNER_WA, profileName: 'ravi', lastInboundAt: now },
      { contact: STRANGER, profileName: '✨✨', lastInboundAt: now },
    ]);
    svc = new QuickMessagesService(
      conv as any,
      member as any,
      tribe as any,
      order as any,
      { sendQuick } as any,
    );
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const byId = (res: any, id: string) =>
    res.messages.find((m: any) => m.id === id);

  it('a member of two tribes must pick one; until then tribe messages are unavailable', async () => {
    const res = await svc.list(MEMBER);
    expect(res.context.tribes.map((t: any) => t.brand).sort()).toEqual([
      'Other Tribe',
      'RV Life Coaching',
    ]);
    expect(res.context.tribeId).toBeNull();
    expect(byId(res, 'tribe.visit_store').available).toBe(false);
    // Latest non-rejected order across tribes: Other Tribe's pending one.
    expect(res.context.order?.statusText).toBe(
      'Awaiting confirmation from Other Tribe',
    );
    expect(res.context.firstName).toBe('Asha');
  });

  it('with a tribe chosen: its store link (encoded) and its latest order with tracking', async () => {
    const res = await svc.list(MEMBER, String(T1));
    expect(res.context.tribeId).toBe(String(T1));
    const store = byId(res, 'tribe.visit_store');
    expect(store.available).toBe(true);
    expect(store.preview.cta.url).toBe(
      'https://tribemerchandise.com/s/RV%20Life%20Coaching',
    );
    expect(store.preview.body).toContain('*RV Life Coaching*');
    expect(res.context.order).toEqual({
      shortId: expect.any(String),
      statusText: 'Shipped — on its way with India Post',
      trackingNumber: 'CA182468665IN',
    });
    const status = byId(res, 'orders.status');
    expect(status.preview.kind).toBe('cta_url');
    expect(status.preview.body).toContain('Platinum Kit Telugu');
    expect(status.preview.body).toMatch(/^Hi Asha/);
  });

  it("recognises a tribe owner by the owner's phone", async () => {
    const res = await svc.list(OWNER_WA);
    expect(res.context.tribes).toEqual([
      {
        id: String(T1),
        brand: 'RV Life Coaching',
        username: 'RV Life Coaching',
      },
    ]);
    expect(res.context.tribeId).toBe(String(T1));
    expect(res.context.firstName).toBe('Ravi');
  });

  it('a stranger gets platform messages only, greeted generically', async () => {
    const res = await svc.list(STRANGER);
    expect(res.context.tribes).toEqual([]);
    expect(res.context.order).toBeNull();
    expect(res.context.firstName).toBeNull();
    expect(byId(res, 'explore.website').preview.body).toMatch(/^Hi there!/);
    expect(byId(res, 'orders.status').reason).toMatch('No order');
  });

  it('send renders server-side and refuses unavailable or unknown messages', async () => {
    await svc.send(MEMBER, 'tribe.kit_feedback', String(T1));
    const [contact, id, payload] = sendQuick.mock.calls[0];
    expect([contact, id, payload.kind]).toEqual([
      MEMBER,
      'tribe.kit_feedback',
      'buttons',
    ]);
    await expect(svc.send(STRANGER, 'tribe.visit_store')).rejects.toThrow(
      'linked to a tribe',
    );
    await expect(svc.send(STRANGER, 'nope')).rejects.toThrow(
      'Unknown quick message',
    );
    await expect(svc.list('910000000000')).rejects.toThrow(
      'No WhatsApp conversation',
    );
  });
});
