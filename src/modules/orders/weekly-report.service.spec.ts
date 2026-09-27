import { WeeklyReportService } from './weekly-report.service';

const service = new WeeklyReportService(null as never, null as never);

/** Friday 6pm IST is 12:30 UTC — the half hour is the point of these tests. */
describe('WeeklyReportService.weeklyWindowEndingAt', () => {
  it('closes exactly at Friday 6pm IST', () => {
    // 2026-09-25 is a Friday; 12:30Z === 18:00 IST.
    const { start, end } = service.weeklyWindowEndingAt(
      new Date('2026-09-25T12:30:00Z'),
    );
    expect(end.toISOString()).toBe('2026-09-25T12:30:00.000Z');
    expect(start.toISOString()).toBe('2026-09-18T12:30:00.000Z');
  });

  it('uses last Friday when run on a Friday before 6pm', () => {
    // 06:00Z Friday === 11:30 IST, the week has not closed yet.
    const { start, end } = service.weeklyWindowEndingAt(
      new Date('2026-09-25T06:00:00Z'),
    );
    expect(end.toISOString()).toBe('2026-09-18T12:30:00.000Z');
    expect(start.toISOString()).toBe('2026-09-11T12:30:00.000Z');
  });

  it('uses this Friday from the weekend and the following week', () => {
    for (const t of [
      '2026-09-26T09:00:00Z', // Saturday
      '2026-09-27T17:00:00Z', // Sunday
      '2026-09-30T04:00:00Z', // Wednesday
      '2026-10-01T12:00:00Z', // Thursday
    ]) {
      const { end } = service.weeklyWindowEndingAt(new Date(t));
      expect(end.toISOString()).toBe('2026-09-25T12:30:00.000Z');
    }
  });

  it('always spans exactly seven days and lands on a Friday 12:30 UTC', () => {
    for (const t of [
      '2026-01-01T00:00:00Z',
      '2026-03-13T12:29:59Z',
      '2026-07-04T23:59:59Z',
      '2026-12-31T18:00:00Z',
    ]) {
      const { start, end } = service.weeklyWindowEndingAt(new Date(t));
      expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
      expect(end.getUTCDay()).toBe(5);
      expect(end.toISOString().slice(11, 19)).toBe('12:30:00');
      expect(end.getTime()).toBeLessThanOrEqual(new Date(t).getTime());
    }
  });

  it('rolls across a year boundary', () => {
    // 2027-01-01 is a Friday; at 00:00Z (05:30 IST) the week hasn't closed.
    const { end } = service.weeklyWindowEndingAt(
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(end.toISOString()).toBe('2026-12-25T12:30:00.000Z');
  });
});

describe('WeeklyReportService.summaryText', () => {
  it('matches the template’s shape and carries no newline', () => {
    const text = service.summaryText([
      { product: 'Diamond Kit', delivered: 4, returned: 1 },
      { product: 'Welcome Kit', delivered: 1, returned: 0 },
    ]);
    expect(text).toContain('Diamond Kit ✅ Delivered: 4 | ↩️ Returned: 1');
    expect(text).toContain('Welcome Kit ✅ Delivered: 1 | ↩️ Returned: 0');
    // Meta rejects parameters containing newlines, tabs, or long space runs.
    expect(text).not.toMatch(/[\n\r\t]/);
    expect(text).not.toMatch(/ {5}/);
  });

  it('never returns an empty parameter', () => {
    expect(service.summaryText([]).length).toBeGreaterThan(0);
  });
});

describe('WeeklyReportService.templateValues', () => {
  const report = {
    tribeId: 't1',
    brand: 'Canvas Of Heritage',
    ownerName: 'ARUN NN',
    phone: '9999999999',
    totalDelivered: 4,
    totalReturned: 1,
    lines: [{ product: 'Diamond Kit', delivered: 4, returned: 1 }],
  };
  const values = service.templateValues(
    report,
    new Date('2026-09-18T12:30:00Z'),
    new Date('2026-09-25T12:30:00Z'),
  );

  it('keeps every parameter_name within Meta’s 20-character limit', () => {
    // Meta accepts an over-long name at template creation and then refuses
    // every send with it, so this is the only place it gets caught early.
    for (const key of Object.keys(values)) {
      expect(key.length).toBeLessThanOrEqual(20);
    }
  });

  it('sends the summary under the renamed key only', () => {
    expect(values.product_summary).toContain('Diamond Kit');
    expect(values.weekly_product_summary).toBeUndefined();
  });

  it('formats the week dates as the template expects', () => {
    expect(values.week_start_date).toBe('2026/09/18');
    expect(values.week_end_date).toBe('2026/09/25');
  });

  it('title-cases the owner name and keeps initials', () => {
    expect(values.client_name).toBe('Arun NN');
  });

  it('sends totals as strings — Meta rejects non-string parameters', () => {
    expect(values.total_delivered).toBe('4');
    expect(values.total_returned).toBe('1');
  });
});
