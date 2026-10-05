import { BadRequestException } from '@nestjs/common';
import {
  bucketLabel,
  buckets,
  defaultGranularity,
  istDateKey,
  istToday,
  rate,
  resolveRange,
} from './analytics-range';

const NOW = new Date('2026-10-05T12:00:00Z'); // 17:30 IST, Monday 5 Oct

describe('resolveRange', () => {
  it('defaults to the last 30 days including today (IST), daily', () => {
    expect(resolveRange({}, NOW)).toMatchObject({
      from: '2026-09-06',
      to: '2026-10-05',
      granularity: 'day',
      spanDays: 30,
    });
  });

  it('takes "today" in IST, not UTC', () => {
    // 19:00 UTC on 4 Oct is 00:30 IST on 5 Oct.
    expect(istToday(new Date('2026-10-04T19:00:00Z')).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(resolveRange({}, new Date('2026-10-04T19:00:00Z')).to).toBe(
      '2026-10-05',
    );
    // 18:29 UTC on 4 Oct is still 4 Oct in IST.
    expect(resolveRange({}, new Date('2026-10-04T18:29:00Z')).to).toBe(
      '2026-10-04',
    );
  });

  it('bounds the range at 00:00 IST on from and 00:00 IST after to', () => {
    const r = resolveRange({ from: '2026-10-01', to: '2026-10-05' }, NOW);
    expect(r.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-05T18:30:00.000Z');
    expect(r.spanDays).toBe(5);
  });

  it('fills a missing from as 29 days before to', () => {
    expect(resolveRange({ to: '2026-03-31' }, NOW).from).toBe('2026-03-02');
  });

  it('picks the default granularity from the span', () => {
    expect(defaultGranularity(1)).toBe('day');
    expect(defaultGranularity(45)).toBe('day');
    expect(defaultGranularity(46)).toBe('week');
    expect(defaultGranularity(180)).toBe('week');
    expect(defaultGranularity(181)).toBe('month');
    expect(
      resolveRange({ from: '2026-01-01', to: '2026-03-01' }, NOW).granularity,
    ).toBe('week');
    expect(
      resolveRange({ from: '2025-10-01', to: '2026-10-01' }, NOW).granularity,
    ).toBe('month');
  });

  it('keeps an explicit granularity', () => {
    expect(
      resolveRange(
        { from: '2025-10-01', to: '2026-10-01', granularity: 'day' },
        NOW,
      ).granularity,
    ).toBe('day');
  });

  it('allows up to 400 days and refuses 401', () => {
    expect(
      resolveRange({ from: '2025-09-01', to: '2026-10-05' }, NOW).spanDays,
    ).toBe(400);
    expect(() =>
      resolveRange({ from: '2025-08-31', to: '2026-10-05' }, NOW),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['from after to', { from: '2026-10-05', to: '2026-10-04' }],
    ['impossible date', { from: '2026-02-30' }],
    ['bad format', { to: '05-10-2026' }],
    ['unknown granularity', { granularity: 'year' }],
  ])('400 on %s', (_label, q) => {
    expect(() => resolveRange(q as any, NOW)).toThrow(BadRequestException);
  });

  it('accepts a single day', () => {
    expect(
      resolveRange({ from: '2026-10-05', to: '2026-10-05' }, NOW).spanDays,
    ).toBe(1);
  });
});

describe('buckets', () => {
  it('lists every day, labelled "05 Oct"', () => {
    const b = buckets('2026-09-29', '2026-10-02', 'day');
    expect(b).toEqual([
      { bucket: '2026-09-29', label: '29 Sep' },
      { bucket: '2026-09-30', label: '30 Sep' },
      { bucket: '2026-10-01', label: '01 Oct' },
      { bucket: '2026-10-02', label: '02 Oct' },
    ]);
  });

  it('starts weeks on Monday, including the week the range starts in', () => {
    // 1 Oct 2026 is a Thursday → its week starts Monday 28 Sep.
    expect(buckets('2026-10-01', '2026-10-19', 'week')).toEqual([
      { bucket: '2026-09-28', label: 'Wk of 28 Sep' },
      { bucket: '2026-10-05', label: 'Wk of 05 Oct' },
      { bucket: '2026-10-12', label: 'Wk of 12 Oct' },
      { bucket: '2026-10-19', label: 'Wk of 19 Oct' },
    ]);
    // A Sunday belongs to the week before; a Monday starts its own.
    expect(buckets('2026-10-04', '2026-10-04', 'week')[0].bucket).toBe(
      '2026-09-28',
    );
    expect(buckets('2026-10-05', '2026-10-05', 'week')[0].bucket).toBe(
      '2026-10-05',
    );
  });

  it('lists months across a year end, labelled "Oct 2026"', () => {
    expect(buckets('2025-11-15', '2026-02-01', 'month')).toEqual([
      { bucket: '2025-11-01', label: 'Nov 2025' },
      { bucket: '2025-12-01', label: 'Dec 2025' },
      { bucket: '2026-01-01', label: 'Jan 2026' },
      { bucket: '2026-02-01', label: 'Feb 2026' },
    ]);
  });

  it('gives the default range 30 daily buckets and 400 days at most 400', () => {
    const r = resolveRange({}, NOW);
    expect(buckets(r.from, r.to, r.granularity)).toHaveLength(30);
    expect(buckets('2025-09-01', '2026-10-05', 'day')).toHaveLength(400);
    expect(buckets('2025-09-01', '2026-10-05', 'month')).toHaveLength(14);
  });

  it('labels', () => {
    const d = new Date(Date.UTC(2026, 9, 5));
    expect(bucketLabel(d, 'day')).toBe('05 Oct');
    expect(bucketLabel(d, 'week')).toBe('Wk of 05 Oct');
    expect(bucketLabel(d, 'month')).toBe('Oct 2026');
  });
});

describe('istDateKey', () => {
  it('maps a $dateTrunc result (IST midnight) back to its IST date', () => {
    expect(istDateKey(new Date('2026-09-27T18:30:00Z'))).toBe('2026-09-28');
    expect(istDateKey(new Date('2026-09-30T18:30:00Z'))).toBe('2026-10-01');
  });
});

describe('rate', () => {
  it('is a/b with 4 decimals, 0 when b is 0, capped at 1', () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(3, 0)).toBe(0);
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(2, 3)).toBe(0.6667);
    expect(rate(5, 5)).toBe(1);
    // Returned in range from dispatches before it.
    expect(rate(4, 2)).toBe(1);
  });
});
