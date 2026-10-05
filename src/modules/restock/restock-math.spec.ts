import {
  compareItems,
  criticalAtOf,
  daysLeftOf,
  levelOf,
  lowAtOf,
  stockHealth,
  suggestedQtyOf,
  weeklyPaceOf,
} from './restock-math';

describe('restock maths', () => {
  describe('weeklyPace', () => {
    it('is the 28-day count / 4, to 2 decimals', () => {
      expect(weeklyPaceOf(40, 10)).toBe(10);
      expect(weeklyPaceOf(7, 1)).toBe(1.75);
      expect(weeklyPaceOf(10, 0)).toBe(2.5);
      expect(weeklyPaceOf(1, 0)).toBe(0.25);
      expect(weeklyPaceOf(9, 2)).toBe(2.25);
    });

    it('is at least this week’s count (a surge counts)', () => {
      // Nothing shipped in the 3 weeks before, 30 this week: 30/4 = 7.5 < 30.
      expect(weeklyPaceOf(30, 30)).toBe(30);
      const h = stockHealth(40, 30, 30);
      expect(h.weeklyPace).toBeGreaterThanOrEqual(30);
      expect(h.lowAt).toBe(60);
      expect(h.criticalAt).toBe(30);
      expect(h.level).toBe('LOW');
    });
  });

  describe('daysLeft', () => {
    it('is 0 when stock is zero or negative', () => {
      expect(daysLeftOf(0, 5)).toBe(0);
      expect(daysLeftOf(-3, 5)).toBe(0);
      expect(daysLeftOf(-3, 0)).toBe(0);
    });

    it('is null when nothing shipped recently (zero pace)', () => {
      expect(daysLeftOf(50, 0)).toBeNull();
      expect(stockHealth(50, 0, 0).daysLeft).toBeNull();
    });

    it('floors stock / (pace / 7)', () => {
      expect(daysLeftOf(25, 100)).toBe(1); // 1.75 days
      expect(daysLeftOf(100, 7)).toBe(100);
      expect(daysLeftOf(10, 7)).toBe(10);
      // 3 / (2.1 / 7) = exactly 10 — float division must not floor it to 9.
      expect(daysLeftOf(3, 2.1)).toBe(10);
      expect(daysLeftOf(7, 0.7)).toBe(70);
    });
  });

  describe('thresholds', () => {
    it('floor at 10 (low) and 5 (critical) for slow movers', () => {
      expect(lowAtOf(0)).toBe(10);
      expect(criticalAtOf(0)).toBe(5);
      expect(lowAtOf(4.9)).toBe(10);
      expect(criticalAtOf(4.9)).toBe(5);
    });

    it('scale with the pace above the floors (ceil)', () => {
      expect(lowAtOf(5.01)).toBe(11);
      expect(criticalAtOf(5.01)).toBe(6);
      expect(lowAtOf(25)).toBe(50);
      expect(criticalAtOf(25)).toBe(25);
    });
  });

  describe('level', () => {
    it.each([
      [-4, 'OUT'],
      [0, 'OUT'],
      [1, 'CRITICAL'],
      [5, 'CRITICAL'],
      [6, 'LOW'],
      [10, 'LOW'],
      [11, 'HEALTHY'],
    ])('stock %d with floor thresholds → %s', (stock, level) => {
      expect(levelOf(stock, 10, 5)).toBe(level);
    });
  });

  describe('suggestedQty', () => {
    it('covers ~4 weeks of pace', () => {
      // pace 25: max(100, 2×50) − 20 = 80
      expect(suggestedQtyOf(20, 25, 50)).toBe(80);
      // pace 30: max(120, 120) − 40
      expect(stockHealth(40, 30, 30).suggestedQty).toBe(80);
    });

    it('is at least back to twice the low level for slow movers', () => {
      // pace 0 → lowAt 10 → 2×10 − 3
      expect(stockHealth(3, 0, 0).suggestedQty).toBe(17);
    });

    it('adds the shortfall for negative stock (OUT)', () => {
      const h = stockHealth(-12, 5, 20); // pace 5 → lowAt 10, max(20, 20) + 12
      expect(h.level).toBe('OUT');
      expect(h.daysLeft).toBe(0);
      expect(h.suggestedQty).toBe(32);
    });

    it('is 0 when already well stocked', () => {
      expect(stockHealth(500, 1, 4).suggestedQty).toBe(0);
      expect(stockHealth(500, 1, 4).level).toBe('HEALTHY');
    });

    it('rounds up fractional paces', () => {
      // pace 7.33 → max(29.32, 2×15) − 0 = 30; lowAt = ceil(14.66) = 15
      const h = stockHealth(0, 7, 29.32);
      expect(h.weeklyPace).toBe(7.33);
      expect(h.lowAt).toBe(15);
      expect(h.criticalAt).toBe(8);
      expect(h.suggestedQty).toBe(30);
    });
  });

  it('sorts by severity, then days left (null last), then name', () => {
    const rows = [
      { name: 'b', level: 'HEALTHY', daysLeft: null },
      { name: 'z', level: 'LOW', daysLeft: null },
      { name: 'a', level: 'LOW', daysLeft: 9 },
      { name: 'y', level: 'LOW', daysLeft: 3 },
      { name: 'c', level: 'OUT', daysLeft: 0 },
      { name: 'b', level: 'OUT', daysLeft: 0 },
      { name: 'q', level: 'CRITICAL', daysLeft: 4 },
    ] as any[];
    expect(rows.sort(compareItems).map((r) => `${r.level}:${r.name}`)).toEqual([
      'OUT:b',
      'OUT:c',
      'CRITICAL:q',
      'LOW:y',
      'LOW:a',
      'LOW:z',
      'HEALTHY:b',
    ]);
  });
});
