import {
  eventTime,
  milestoneOf,
  parsePostalPayload,
} from './postal-event-rules';

const sample = {
  article_number: 'aw784699994in',
  event_date: '2025-11-09',
  event_time: '08:37:52',
  event_office_facility_id: '21250003',
  event_office_name: 'KADUGODI BNPL CENTRE',
  event_code: 'BAG_CLOSE',
  event_description: 'Bag Close',
  non_delivery_reason: '',
};

describe('parsePostalPayload', () => {
  it("reads India Post's documented single-object payload", () => {
    const [e] = parsePostalPayload(sample);
    expect(e).toMatchObject({
      articleNumber: 'AW784699994IN',
      eventCode: 'BAG_CLOSE',
      description: 'Bag Close',
      office: 'KADUGODI BNPL CENTRE',
      officeId: '21250003',
    });
    expect(e.eventAt.toISOString()).toBe('2025-11-09T03:07:52.000Z'); // IST → UTC
  });

  it('accepts an array or a wrapped list, and drops entries without a valid article number', () => {
    expect(parsePostalPayload([sample, sample])).toHaveLength(2);
    expect(parsePostalPayload({ events: [sample] })).toHaveLength(1);
    expect(
      parsePostalPayload({ data: [sample, { article_number: 'nope' }] }),
    ).toHaveLength(1);
    expect(parsePostalPayload({ test: true })).toEqual([]);
    expect(parsePostalPayload('hello')).toEqual([]);
    expect(parsePostalPayload(null)).toEqual([]);
  });
});

describe('eventTime', () => {
  it('falls back to now for a missing date and to midnight for a missing time', () => {
    expect(eventTime('2026-10-01', '').toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
    expect(Math.abs(eventTime('', '').getTime() - Date.now())).toBeLessThan(
      1000,
    );
  });
});

describe('milestoneOf', () => {
  it.each([
    ['ITEM_BOOK', 'Item Booked', 'BOOKED'],
    ['', 'Item Booked', 'BOOKED'],
    ['ITEM_DELIVERY', 'Item Delivered', 'DELIVERED'],
    ['DELIVERED', '', 'DELIVERED'],
    ['ITEM_NOT_DELIVERED', 'Item not Delivered', null],
    ['', 'Item Non-Delivered', null],
    ['', 'Taken out for delivery', null],
    ['', 'Delivery Attempted', null],
    ['ITEM_RETURN', 'Item Returned', 'RETURNED'],
    ['', 'Item Redirected', null],
    ['BAG_CLOSE', 'Bag Close', null],
    ['', 'Item on Hold', null],
  ])('%s / %s → %s', (code, desc, expected) => {
    expect(milestoneOf(code, desc)).toBe(expected);
  });
});
