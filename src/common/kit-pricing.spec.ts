import {
  allocate,
  allocateUnitPrices,
  formatInr,
  kitTotals,
} from './kit-pricing';

const paise = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100);

describe('kit pricing helpers', () => {
  it('kitTotals sums retail and production cost by quantity, skipping gone products', () => {
    expect(
      kitTotals([
        {
          quantity: 2,
          product: { retailPrice: 300, baseProductionCost: 100.5 },
        },
        { quantity: 1, product: { retailPrice: 120, baseProductionCost: 50 } },
        { quantity: 3, product: null },
      ]),
    ).toEqual({ productValue: 720, minPrice: 251 });
  });

  it('formats rupees for messages', () => {
    expect(formatInr(250)).toBe('₹250');
    expect(formatInr(250.5)).toBe('₹250.50');
  });

  it('allocate sums exactly, never negative, with zero weights falling back', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts).toEqual([33.33, 33.33, 33.34]);
    expect(allocate(10, [0, 0], [1, 3])).toEqual([2.5, 7.5]);
    expect(allocate(0.01, [5, 0])).toEqual([0.01, 0]);
    for (let t = 0; t < 200; t++) {
      const total = Math.round(Math.random() * 1e6) / 100;
      const ws = [
        Math.random() * 500,
        Math.random() * 500,
        Math.random() * 500,
      ];
      const out = allocate(total, ws);
      expect(paise(out)).toBe(Math.round(total * 100));
      expect(out.every((p) => p >= 0 && Number(p.toFixed(2)) === p)).toBe(true);
    }
  });

  it('allocateUnitPrices lands exactly whenever a line has a single unit', () => {
    for (let t = 0; t < 200; t++) {
      const total = Math.round(Math.random() * 1e6) / 100;
      const qs = [
        1 + Math.floor(Math.random() * 4),
        1,
        1 + Math.floor(Math.random() * 4),
      ];
      const ws = qs.map((q) => q * Math.random() * 500);
      const units = allocateUnitPrices(total, ws, qs);
      expect(paise(units.map((u, i) => u * qs[i]))).toBe(
        Math.round(total * 100),
      );
      expect(units.every((u) => u >= 0)).toBe(true);
    }
  });
});
