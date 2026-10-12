import {
  QUICK_CATEGORIES,
  QUICK_MESSAGES,
  limitProblems,
  previewText,
  toInteractive,
  unavailableReason,
  type QuickContext,
} from './quick-messages';

const full: QuickContext = {
  firstName: 'Asha',
  siteUrl: 'https://tribemerchandise.com',
  tribe: {
    id: 't1',
    brand: 'RV Life Coaching & Manifestation Academy International Community',
    storeUrl: 'https://tribemerchandise.com/s/rvlife',
  },
  order: {
    shortId: '7F09FC5F',
    status: 'DISPATCHED',
    statusText: 'Shipped — on its way with India Post',
    trackingNumber: 'CA182468665IN',
    campaignName: 'Platinum Kit Telugu',
    brand: 'RV Life Coaching',
  },
};
const bare: QuickContext = { siteUrl: 'https://tribemerchandise.com' };

describe('quick messages catalogue', () => {
  it('has unique ids and only known categories, with every category used', () => {
    const ids = QUICK_MESSAGES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(QUICK_CATEGORIES.map((c) => c.id));
    for (const m of QUICK_MESSAGES) expect(cats.has(m.category)).toBe(true);
    for (const c of cats)
      expect(QUICK_MESSAGES.some((m) => m.category === c)).toBe(true);
  });

  it.each(QUICK_MESSAGES.map((m) => [m.id, m]))(
    '%s renders within WhatsApp limits (full context)',
    (_id, m) => {
      expect(limitProblems(m.render(full))).toEqual([]);
    },
  );

  it('every message usable without context renders within limits there too', () => {
    for (const m of QUICK_MESSAGES.filter((x) => !unavailableReason(x, bare))) {
      const p = m.render(bare);
      expect(limitProblems(p)).toEqual([]);
      expect(p.body).toMatch(/^Hi there/);
    }
  });

  it('uses buttons, link buttons and a list', () => {
    const kinds = new Set(QUICK_MESSAGES.map((m) => m.render(full).kind));
    expect(kinds).toEqual(new Set(['text', 'buttons', 'cta_url', 'list']));
  });

  it('includes tribe info and the store link in tribe messages', () => {
    const p: any = QUICK_MESSAGES.find(
      (m) => m.id === 'tribe.visit_store',
    )!.render(full);
    expect(p.body).toContain(full.tribe!.brand);
    expect(p.cta.url).toBe('https://tribemerchandise.com/s/rvlife');
    expect(p.header.length).toBeLessThanOrEqual(60);
  });
});

describe('unavailableReason', () => {
  const byId = (id: string) => QUICK_MESSAGES.find((m) => m.id === id)!;
  it('explains what a chat is missing', () => {
    expect(unavailableReason(byId('tribe.visit_store'), bare)).toMatch(
      'linked to a tribe',
    );
    expect(
      unavailableReason(byId('tribe.visit_store'), {
        ...bare,
        tribe: { id: 't', brand: 'X' },
      }),
    ).toMatch('no store link');
    expect(unavailableReason(byId('orders.status'), bare)).toMatch('No order');
    expect(
      unavailableReason(byId('orders.delayed'), {
        ...bare,
        order: { ...full.order!, trackingNumber: undefined },
      }),
    ).toMatch('no tracking number');
    expect(unavailableReason(byId('explore.website'), bare)).toBeNull();
  });

  it('order status without tracking falls back to plain text', () => {
    const p = byId('orders.status').render({
      ...full,
      order: { ...full.order!, trackingNumber: undefined },
    });
    expect(p.kind).toBe('text');
  });
});

describe('toInteractive / previewText', () => {
  it('maps buttons, CTA and list onto the Cloud API shape', () => {
    const buttons: any = toInteractive(
      QUICK_MESSAGES.find((m) => m.id === 'service.welcome')!.render(full),
    );
    expect(buttons.type).toBe('button');
    expect(buttons.action.buttons[0]).toEqual({
      type: 'reply',
      reply: { id: 'svc:track', title: '📦 Track my order' },
    });
    expect(buttons.header).toEqual({ type: 'text', text: 'Tribe Merchandise' });

    const cta: any = toInteractive(
      QUICK_MESSAGES.find((m) => m.id === 'explore.estimate')!.render(full),
    );
    expect(cta).toMatchObject({
      type: 'cta_url',
      action: {
        name: 'cta_url',
        parameters: {
          display_text: 'Get estimate',
          url: 'https://tribemerchandise.com/estimate',
        },
      },
    });

    const list: any = toInteractive(
      QUICK_MESSAGES.find((m) => m.id === 'feedback.rating')!.render(full),
    );
    expect(list.type).toBe('list');
    expect(list.action.button).toBe('Rate us');
    expect(list.action.sections[0].rows).toHaveLength(5);

    expect(toInteractive({ kind: 'text', body: 'x' })).toBeNull();
  });

  it('writes a readable inbox preview including the buttons', () => {
    const t = previewText(
      QUICK_MESSAGES.find((m) => m.id === 'service.resolved_check')!.render(
        full,
      ),
    );
    expect(t).toContain('Hi Asha');
    expect(t).toContain('[ ✅ Yes, all good ]');
  });
});
