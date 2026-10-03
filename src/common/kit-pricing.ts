import { BadRequestException } from '@nestjs/common';

// Money helpers for kit pricing. All INR; amounts are kept to 2 dp.

/** Rounds to paise (2 dp). */
export const roundMoney = (n: number): number =>
  Math.round((Number(n) || 0) * 100) / 100;

/** ₹ amount for messages: whole rupees bare, otherwise 2 dp. */
export const formatInr = (n: number): string => {
  const v = roundMoney(n);
  return `₹${Number.isInteger(v) ? v : v.toFixed(2)}`;
};

/** A line of a kit (or kit-linked campaign) with its product loaded. */
export interface PricedLine {
  quantity?: number;
  product?: { baseProductionCost?: number; retailPrice?: number } | null;
}

/**
 * The two reference prices of a kit's contents:
 * - `productValue` = Σ retailPrice × qty (the fallback price when none is set)
 * - `minPrice` = Σ baseProductionCost × qty (no kit or campaign may go below it)
 * Lines without a product (deleted) count for nothing.
 */
export function kitTotals(lines: PricedLine[]): {
  productValue: number;
  minPrice: number;
} {
  let productValue = 0;
  let minPrice = 0;
  for (const line of lines) {
    if (!line.product) continue;
    const qty = line.quantity || 1;
    productValue += (line.product.retailPrice || 0) * qty;
    minPrice += (line.product.baseProductionCost || 0) * qty;
  }
  return {
    productValue: roundMoney(productValue),
    minPrice: roundMoney(minPrice),
  };
}

export const belowMinMessage = (min: number) =>
  `Kit price can't be below the production cost of its products (${formatInr(min)})`;

/** 400 when a set price is below the production-cost floor. */
export function assertPriceAtLeast(
  price: number | null | undefined,
  min: number,
) {
  if (price == null) return;
  if (roundMoney(price) < roundMoney(min)) {
    throw new BadRequestException(belowMinMessage(min));
  }
}

const weightSum = (ws: number[]) =>
  ws.reduce((a, b) => a + Math.max(0, b || 0), 0);

// The weights to split by: `weights`, else `fallbackWeights` when every
// weight is zero, else equal shares.
function pickWeights(weights: number[], fallbackWeights?: number[]): number[] {
  if (weightSum(weights) > 0) return weights;
  if (fallbackWeights && weightSum(fallbackWeights) > 0) return fallbackWeights;
  return weights.map(() => 1);
}

/**
 * Splits `total` over lines in proportion to `weights`, in whole paise, so the
 * parts add up to exactly `total`. Every line but the last is rounded down and
 * the last takes the remainder, so no part is ever negative. All-zero weights
 * fall back to `fallbackWeights` (e.g. quantities), then to equal shares.
 */
export function allocate(
  total: number,
  weights: number[],
  fallbackWeights?: number[],
): number[] {
  if (!weights.length) return [];
  const ws = pickWeights(weights, fallbackWeights);
  const w = weightSum(ws);
  const totalPaise = Math.round((Number(total) || 0) * 100);
  const parts: number[] = [];
  let used = 0;
  ws.forEach((wi, i) => {
    if (i === ws.length - 1) {
      parts.push(totalPaise - used);
      return;
    }
    const p = Math.floor((totalPaise * Math.max(0, wi || 0)) / w);
    parts.push(p);
    used += p;
  });
  return parts.map((p) => p / 100);
}

/**
 * Per-unit prices (2 dp) for lines of `quantities` units, in proportion to
 * `weights`, such that Σ unitPrice × quantity is exactly `total`. Each line is
 * rounded down to the paisa per unit; the leftover paise go to the last line
 * whose quantity divides them — always possible when some line has a single
 * unit, which is how a split claim arrives. Only if no line can take them
 * evenly does the last line round, leaving the sum off by under a paisa per
 * unit on that line.
 */
export function allocateUnitPrices(
  total: number,
  weights: number[],
  quantities: number[],
): number[] {
  if (!weights.length) return [];
  const qs = quantities.map((q) => Math.max(1, Math.floor(q) || 1));
  const ws = pickWeights(weights, qs);
  const w = weightSum(ws);
  const totalPaise = Math.round((Number(total) || 0) * 100);
  const units = ws.map((wi, i) =>
    Math.floor((totalPaise * Math.max(0, wi || 0)) / w / qs[i]),
  );
  const rem = totalPaise - units.reduce((a, u, i) => a + u * qs[i], 0);
  if (rem > 0) {
    let target = -1;
    for (let i = qs.length - 1; i >= 0; i--) {
      if (rem % qs[i] === 0) {
        target = i;
        break;
      }
    }
    if (target >= 0) units[target] += rem / qs[target];
    else units[qs.length - 1] += Math.round(rem / qs[qs.length - 1]);
  }
  return units.map((u) => u / 100);
}

/**
 * A kit's items as campaign product lines: product, units per claim, and the
 * product's own retail price. Items whose product is gone are left out.
 */
export function campaignProductsFor(
  items: { productId: any; quantity?: number }[],
  byId: Map<string, { retailPrice?: number }>,
) {
  return items
    .filter((i) => byId.has(String(i.productId)))
    .map((i) => ({
      productId: i.productId,
      quantity: i.quantity || 1,
      retailPrice: byId.get(String(i.productId))!.retailPrice || 0,
    }));
}
