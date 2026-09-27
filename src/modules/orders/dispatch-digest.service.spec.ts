import { DispatchDigestService } from './dispatch-digest.service';

function makeService() {
  return new DispatchDigestService(null as never, null as never);
}

/** 21:00 IST is 15:30 UTC — the half hour is the whole point of these tests. */
const ist = (iso: string) => new Date(iso);

describe('DispatchDigestService.windowEndingAt', () => {
  const service = makeService();

  it('lands exactly on 9pm IST, not 8:30 or 9:30', () => {
    // 2026-09-27T15:30Z === 21:00 IST
    const { start, end } = service.windowEndingAt(ist('2026-09-27T15:30:00Z'));
    expect(end.toISOString()).toBe('2026-09-27T15:30:00.000Z');
    expect(start.toISOString()).toBe('2026-09-26T15:30:00.000Z');
  });

  it('covers yesterday 9pm to today 9pm when run at the cutoff', () => {
    const { start, end } = service.windowEndingAt(ist('2026-09-27T15:30:05Z'));
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(end.toISOString()).toBe('2026-09-27T15:30:00.000Z');
  });

  it('uses yesterday’s cutoff when run before 9pm IST', () => {
    // 05:00Z === 10:30 IST, so the last cutoff was yesterday 9pm.
    const { start, end } = service.windowEndingAt(ist('2026-09-27T05:00:00Z'));
    expect(end.toISOString()).toBe('2026-09-26T15:30:00.000Z');
    expect(start.toISOString()).toBe('2026-09-25T15:30:00.000Z');
  });

  it('handles the hours after midnight IST, which are still the previous day’s window', () => {
    // 19:00Z on the 27th === 00:30 IST on the 28th.
    const { start, end } = service.windowEndingAt(ist('2026-09-27T19:00:00Z'));
    expect(end.toISOString()).toBe('2026-09-27T15:30:00.000Z');
    expect(start.toISOString()).toBe('2026-09-26T15:30:00.000Z');
  });

  it('rolls across a month boundary', () => {
    // 2026-10-01T05:00Z === 10:30 IST on the 1st → cutoff was 30 Sep 9pm.
    const { end } = service.windowEndingAt(ist('2026-10-01T05:00:00Z'));
    expect(end.toISOString()).toBe('2026-09-30T15:30:00.000Z');
  });

  it('always spans exactly 24 hours, whenever it runs', () => {
    for (const t of [
      '2026-01-01T00:00:00Z',
      '2026-03-15T15:29:59Z',
      '2026-06-30T15:30:01Z',
      '2026-12-31T23:59:59Z',
    ]) {
      const { start, end } = service.windowEndingAt(new Date(t));
      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
      // Every cutoff is 15:30 UTC.
      expect(end.toISOString().slice(11, 19)).toBe('15:30:00');
      expect(end.getTime()).toBeLessThanOrEqual(new Date(t).getTime());
    }
  });
});

describe('DispatchDigestService.summaryText', () => {
  const service = makeService();

  it('never emits a newline — Meta rejects parameters containing one', () => {
    const text = service.summaryText([
      { product: 'Silver Membership Kit', shipments: 12 },
      { product: 'Books', shipments: 5 },
    ]);
    expect(text).not.toMatch(/[\n\r\t]/);
    // Nor more than four consecutive spaces, which Meta also rejects.
    expect(text).not.toMatch(/ {5}/);
  });

  it('singularises a lone shipment', () => {
    expect(service.summaryText([{ product: 'Books', shipments: 1 }])).toBe(
      '📦 Books — 1 shipment',
    );
  });

  it('lists every product', () => {
    const text = service.summaryText([
      { product: 'Silver Membership Kit', shipments: 12 },
      { product: 'Books', shipments: 5 },
    ]);
    expect(text).toContain('Silver Membership Kit — 12 shipments');
    expect(text).toContain('Books — 5 shipments');
  });

  it('degrades rather than sending an empty parameter', () => {
    // Meta rejects a blank parameter outright.
    expect(service.summaryText([]).length).toBeGreaterThan(0);
  });
});
