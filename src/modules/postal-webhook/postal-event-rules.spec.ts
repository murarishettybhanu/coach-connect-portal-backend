import {
  eventTime,
  isMovementScan,
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
  it('falls back to today (IST) for a missing date and to midnight for a missing time', () => {
    expect(eventTime('2026-10-01', '').toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
    // Missing date: today's IST date, so a retried event dedupes to the same instant.
    const a = eventTime('', '10:15:00');
    expect(eventTime('', '10:15:00').getTime()).toBe(a.getTime());
    expect(
      new Date(a.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10),
    ).toBe(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10));
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

describe('isMovementScan', () => {
  it.each([
    ['Item Booked', true],
    ['Item Bagged', true],
    ['Bag Received', true],
    ['Item Dispatched', true],
    ['Item Received', true],
    ['Taken out for delivery', true],
    ['Item Kept on Hold', true],
    ['Item Delivered', true],
    ['Item Returned', true],
    ['Pickup Request Raised', false],
    ['Pre-advice received', false],
    ['Manifest Generated', false],
    ['Label Printed', false],
    ['Booking Cancelled', false],
    ['', false],
  ])('%s → %s', (desc, expected) => {
    expect(isMovementScan('', desc as string)).toBe(expected);
  });
});

describe('milestoneOf — real India Post wordings (review fixes)', () => {
  it.each([
    ['Item Delivered', null, 'DELIVERED'],
    ['Item Delivered to sender', null, 'RETURNED'],
    ['Delivered to Sender', null, 'RETURNED'],
    ['Item Returned to Sender', null, 'RETURNED'],
    ['Return Item Received', null, 'RETURNED'],
    ['Item Delivery Failed', null, null],
    ['Delivery Unsuccessful', null, null],
    ['Item Received at Delivery Office', null, null],
    ['Item Dispatched to Delivery Office', null, null],
    ['Item not Delivered', null, null],
    ['Intimation Delivered', null, null],
    ['Out for delivery', null, null],
    ['Booking Cancelled', null, null],
  ])('%s → %s', (desc, _code, expected) => {
    expect(milestoneOf('', desc as string)).toBe(expected);
  });

  it('the bare code ITEM_DELIVERY is a delivery', () => {
    expect(milestoneOf('ITEM_DELIVERY', '')).toBe('DELIVERED');
  });

  it('never DELIVERED when a non-delivery reason is given', () => {
    expect(
      milestoneOf('ITEM_DELIVERY', 'Item Delivered', 'Addressee not available'),
    ).toBeNull();
  });

  it('on hold / not delivered / intimation are movement (India Post has it)', () => {
    for (const d of [
      'Item Onhold',
      'Item Kept on Hold',
      'Item not Delivered',
      'Intimation Delivered',
    ]) {
      expect(isMovementScan('', d)).toBe(true);
    }
  });

  it('eventTime accepts a one-digit hour and H:MM', () => {
    expect(eventTime('2026-10-14', '8:37:52').toISOString()).toBe(
      '2026-10-14T03:07:52.000Z',
    );
    expect(eventTime('2026-10-14', '8:37').toISOString()).toBe(
      '2026-10-14T03:07:00.000Z',
    );
  });
});
