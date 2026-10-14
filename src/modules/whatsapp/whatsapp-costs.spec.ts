import {
  dailySeries,
  lastMonths,
  monthRange,
  templateRows,
  totalsOf,
} from './whatsapp-costs';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe('whatsapp costs', () => {
  it('month ranges are UTC calendar months, capped at now', () => {
    expect(monthRange('2026-09', new Date('2026-12-01'))).toEqual({
      start: day('2026-09-01'),
      end: day('2026-10-01'),
    });
    expect(monthRange('2026-10', new Date('2026-10-14T12:00:00Z')).end).toBe(
      Date.parse('2026-10-14T12:00:00Z') / 1000,
    );
    expect(() => monthRange('2026-1')).toThrow();
  });

  it('lists the current month and those before it, newest first, across years', () => {
    expect(lastMonths(4, new Date('2026-02-10T00:00:00Z'))).toEqual([
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
    ]);
  });

  it('totals cost and messages by category', () => {
    const t = totalsOf([
      {
        start: day('2026-10-01'),
        end: 0,
        volume: 10,
        cost: 1.15,
        pricing_category: 'UTILITY',
      },
      {
        start: day('2026-10-02'),
        end: 0,
        volume: 5,
        cost: 0.575,
        pricing_category: 'UTILITY',
      },
      {
        start: day('2026-10-02'),
        end: 0,
        volume: 3,
        cost: 0.345,
        pricing_category: 'AUTHENTICATION',
      },
      {
        start: day('2026-10-02'),
        end: 0,
        volume: 7,
        cost: 0,
        pricing_category: 'SERVICE',
      },
    ]);
    expect(t).toEqual({
      messages: 25,
      cost: 2.07,
      byCategory: {
        UTILITY: { messages: 15, cost: 1.725 },
        AUTHENTICATION: { messages: 3, cost: 0.345 },
        SERVICE: { messages: 7, cost: 0 },
      },
    });
  });

  it('daily series is zero-filled for every day in range', () => {
    const s = dailySeries(
      [
        {
          start: day('2026-10-02'),
          end: 0,
          volume: 4,
          cost: 0.46,
          pricing_category: 'UTILITY',
        },
      ],
      day('2026-10-01'),
      day('2026-10-04'),
    );
    expect(s.map((d) => d.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(s[1]).toMatchObject({
      cost: 0.46,
      messages: 4,
      UTILITY: 0.46,
      UTILITY_messages: 4,
    });
    expect(s[0]).toMatchObject({ cost: 0, messages: 0 });
  });

  it('template rows add only amount_spent, count unique clicks, and sort by cost', () => {
    const rows = templateRows(
      [
        {
          template_id: 'A',
          start: 0,
          end: 0,
          sent: 23,
          delivered: 20,
          read: 10,
          clicked: [
            { type: 'url_button', count: 9 },
            { type: 'unique_url_button', count: 6 },
          ],
          cost: [
            { type: 'amount_spent', value: 2.3 },
            { type: 'cost_per_delivered', value: 0.12 },
            { type: 'cost_per_url_button_click', value: 0.38 },
          ],
        },
        {
          template_id: 'A',
          start: 0,
          end: 0,
          sent: 1,
          delivered: 1,
          read: 0,
          cost: [
            { type: 'amount_spent', value: 0.12 },
            { type: 'cost_per_delivered', value: 0.12 },
          ],
        },
        {
          template_id: 'B',
          start: 0,
          end: 0,
          sent: 50,
          delivered: 50,
          read: 0,
          cost: [{ type: 'amount_spent', value: 5.75 }],
        },
        {
          template_id: 'C',
          start: 0,
          end: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          cost: [],
        },
      ],
      [
        {
          id: 'A',
          name: 'order_dispach_with_track_button',
          category: 'UTILITY',
        },
        {
          id: 'B',
          name: 'order_confirmation_message_to_customer',
          category: 'UTILITY',
        },
      ],
    );
    expect(
      rows.map((r) => [r.name, r.sent, r.cost, r.clicks, r.costPerDelivered]),
    ).toEqual([
      ['order_confirmation_message_to_customer', 50, 5.75, 0, 0.115],
      ['order_dispach_with_track_button', 24, 2.42, 6, 0.115],
    ]);
  });
});
