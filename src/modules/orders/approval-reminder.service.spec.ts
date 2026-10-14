import { Types } from 'mongoose';
import {
  ApprovalReminderService,
  isReminderDay,
  productList,
} from './approval-reminder.service';

const chain = (v: unknown) => {
  const q: any = {
    select: () => q,
    populate: () => q,
    lean: () => q,
    exec: jest.fn().mockResolvedValue(v),
  };
  return q;
};
const ist = (s: string) => new Date(`${s}+05:30`);

describe('isReminderDay', () => {
  it('fires every 3rd IST day from the anchor, straight across month ends', () => {
    const days: string[] = [];
    for (let d = 0; d < 21; d++) {
      const date = new Date(ist('2026-10-15T08:00:00').getTime() + d * 864e5);
      if (isReminderDay(date)) days.push(date.toISOString().slice(0, 10));
    }
    expect(days).toEqual([
      '2026-10-15',
      '2026-10-18',
      '2026-10-21',
      '2026-10-24',
      '2026-10-27',
      '2026-10-30',
      '2026-11-02',
    ]);
  });
  it('uses the IST date (8am IST is still the same IST day)', () => {
    expect(isReminderDay(ist('2026-10-18T00:30:00'))).toBe(true);
    expect(isReminderDay(ist('2026-10-17T23:59:00'))).toBe(false);
    expect(isReminderDay(ist('2026-10-12T08:00:00'))).toBe(true); // before the anchor too
  });
});

describe('productList', () => {
  it('lists products with counts on one line', () => {
    expect(
      productList([
        { product: 'Platinum Kit Telugu', count: 17 },
        { product: 'Platinum Kit Tamil', count: 1 },
      ]),
    ).toBe('Platinum Kit Telugu: 17 orders, Platinum Kit Tamil: 1 order');
  });
  it('caps long lists with "and N more" and never carries newlines', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      product: `Kit number ${i}`,
      count: i + 1,
    }));
    const out = productList(many, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toMatch(/, and \d+ more$/);
    expect(productList([{ product: 'A\nB\tC', count: 2 }])).toBe(
      'A B C: 2 orders',
    );
    expect(
      productList([{ product: 'X'.repeat(300), count: 1 }], 100).length,
    ).toBeLessThanOrEqual(100);
  });
});

describe('ApprovalReminderService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  const owner = (name: string, phone?: string) => ({
    name,
    phoneNumber: phone,
  });
  const tribe = (brand: string, o: any, extra: any = {}) => ({
    _id: new Types.ObjectId(),
    brand,
    userId: o,
    ...extra,
  });
  const T1 = tribe('RV Life Coaching', owner('ravi KUMAR', '9111111111'));
  const T2 = tribe('Zen Circle', owner('Meena', undefined));
  const OFF = tribe('Closed Tribe', owner('X', '9222222222'), {
    isActive: false,
  });
  const pending = (t: any, campaign?: string) => ({
    coachId: t,
    campaignId: campaign ? { name: campaign } : null,
  });
  const ORDERS = [
    pending(T1, 'Platinum Kit Telugu'),
    pending(T1, 'Platinum Kit Telugu'),
    pending(T1, 'Platinum Kit Tamil'),
    pending(T2, 'Starter Kit'),
    pending(OFF, 'Old Kit'),
  ];

  function setup(orders = ORDERS) {
    const orderModel = { find: jest.fn(() => chain(orders)) };
    const whatsapp = { sendTemplateByIdTo: jest.fn().mockResolvedValue({}) };
    return {
      svc: new ApprovalReminderService(orderModel as any, whatsapp as any),
      orderModel,
      whatsapp,
    };
  }

  it('groups pending welcome-kit claims per active tribe and product', async () => {
    const { svc, orderModel } = setup();
    const r = await svc.buildReminders();
    expect((orderModel.find.mock.calls[0] as any)[0]).toEqual({
      type: 'WELCOME_KIT',
      approvalStatus: 'PENDING',
      isDeleted: { $ne: true },
    });
    expect(r.map((x) => [x.brand, x.pending])).toEqual([
      ['RV Life Coaching', 3],
      ['Zen Circle', 1],
    ]);
    expect(r[0].lines).toEqual([
      { product: 'Platinum Kit Telugu', count: 2 },
      { product: 'Platinum Kit Tamil', count: 1 },
    ]);
    expect(svc.templateValues(r[0])).toEqual({
      owner: 'Ravi Kumar',
      count: '3',
      products: 'Platinum Kit Telugu: 2 orders, Platinum Kit Tamil: 1 order',
    });
  });

  it('dry run by default: logs, sends nothing', async () => {
    delete process.env.WHATSAPP_DIGEST_ENABLED;
    delete process.env.WHATSAPP_DIGEST_TEST_NUMBER;
    const { svc, whatsapp } = setup();
    await svc.run();
    expect(whatsapp.sendTemplateByIdTo).not.toHaveBeenCalled();
  });

  it('enabled: sends to owners with a phone, skips the rest, survives a failure', async () => {
    process.env.WHATSAPP_DIGEST_ENABLED = 'true';
    delete process.env.WHATSAPP_DIGEST_TEST_NUMBER;
    const { svc, whatsapp } = setup([
      ...ORDERS,
      pending(tribe('Third', owner('Z', '9333333333')), 'K'),
    ]);
    whatsapp.sendTemplateByIdTo.mockRejectedValueOnce(new Error('Meta down'));
    await svc.run();
    // RV (fails, continues) and Third; Zen has no phone; the inactive tribe is excluded.
    expect(
      whatsapp.sendTemplateByIdTo.mock.calls.map((c: any) => c[0]),
    ).toEqual(['9111111111', '9333333333']);
    expect((whatsapp.sendTemplateByIdTo.mock.calls[0] as any)[1]).toBe(
      '1520220833273015',
    );
  });

  it('test number: everything goes to it', async () => {
    process.env.WHATSAPP_DIGEST_TEST_NUMBER = '9999999999';
    const { svc, whatsapp } = setup();
    await svc.run();
    expect(
      whatsapp.sendTemplateByIdTo.mock.calls.map((c: any) => c[0]),
    ).toEqual(['9999999999', '9999999999']);
  });

  it('the scheduled run does nothing on non-reminder days', async () => {
    jest.useFakeTimers().setSystemTime(ist('2026-10-16T08:00:00'));
    const { svc, orderModel } = setup();
    await svc.runScheduled();
    expect(orderModel.find).not.toHaveBeenCalled();
    jest.setSystemTime(ist('2026-10-18T08:00:00'));
    await svc.runScheduled();
    expect(orderModel.find).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
