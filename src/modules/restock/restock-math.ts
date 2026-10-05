// Pure stock-health maths behind the restock overview. Every rule here is
// fixed by the shared restock contract ("Definitions") — the frontend only
// displays these numbers, so change them only together with the contract.

export type RestockLevel = 'HEALTHY' | 'LOW' | 'CRITICAL' | 'OUT';

/** "This week" = the last 7 days, rolling. */
export const WINDOW_DAYS = 7;
/** The pace is averaged over the last 28 days (4 weeks). */
export const PACE_DAYS = 28;

export const LOW_FLOOR = 10;
export const CRITICAL_FLOOR = 5;

/** Most urgent first — the overview's sort order. */
export const LEVEL_ORDER: Record<RestockLevel, number> = {
  OUT: 0,
  CRITICAL: 1,
  LOW: 2,
  HEALTHY: 3,
};

export interface StockHealth {
  weeklyPace: number;
  daysLeft: number | null;
  lowAt: number;
  criticalAt: number;
  level: RestockLevel;
  suggestedQty: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Average units dispatched per week over the last 28 days, but never below
 * this week's count (so a sudden surge counts). 2 decimals.
 */
export function weeklyPaceOf(shipped28d: number, shippedThisWeek: number) {
  return round2(Math.max(shipped28d / (PACE_DAYS / 7), shippedThisWeek));
}

/** stock <= 0 → 0; no recent shipping → null; else whole days at the pace. */
export function daysLeftOf(stock: number, weeklyPace: number): number | null {
  if (stock <= 0) return 0;
  if (weeklyPace <= 0) return null;
  // stock / (pace / 7), done in hundredths of a unit (the pace has 2
  // decimals) so it is integer division and float error can't nudge floor().
  return Math.floor((stock * 700) / Math.round(weeklyPace * 100));
}

/** ≈ two weeks of stock, at least 10 units. */
export function lowAtOf(weeklyPace: number) {
  return Math.max(LOW_FLOOR, Math.ceil(2 * weeklyPace));
}

/** ≈ one week of stock, at least 5 units. */
export function criticalAtOf(weeklyPace: number) {
  return Math.max(CRITICAL_FLOOR, Math.ceil(weeklyPace));
}

export function levelOf(
  stock: number,
  lowAt: number,
  criticalAt: number,
): RestockLevel {
  if (stock <= 0) return 'OUT';
  if (stock <= criticalAt) return 'CRITICAL';
  if (stock <= lowAt) return 'LOW';
  return 'HEALTHY';
}

/**
 * The restock form's default: enough for ~4 weeks and at least back above
 * twice the low level. Negative stock (a shortfall) is added on top.
 */
export function suggestedQtyOf(
  stock: number,
  weeklyPace: number,
  lowAt: number,
) {
  return Math.max(0, Math.ceil(Math.max(4 * weeklyPace, 2 * lowAt) - stock));
}

/** Everything the overview derives from stock + dispatch counts. */
export function stockHealth(
  stock: number,
  shippedThisWeek: number,
  shipped28d: number,
): StockHealth {
  const weeklyPace = weeklyPaceOf(shipped28d, shippedThisWeek);
  const lowAt = lowAtOf(weeklyPace);
  const criticalAt = criticalAtOf(weeklyPace);
  return {
    weeklyPace,
    daysLeft: daysLeftOf(stock, weeklyPace),
    lowAt,
    criticalAt,
    level: levelOf(stock, lowAt, criticalAt),
    suggestedQty: suggestedQtyOf(stock, weeklyPace, lowAt),
  };
}

/** Severity, then days left (null — no recent shipping — last), then name. */
export function compareItems(
  a: { level: RestockLevel; daysLeft: number | null; name: string },
  b: { level: RestockLevel; daysLeft: number | null; name: string },
) {
  const bySeverity = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  if (bySeverity) return bySeverity;
  if (a.daysLeft !== b.daysLeft) {
    if (a.daysLeft == null) return 1;
    if (b.daysLeft == null) return -1;
    return a.daysLeft - b.daysLeft;
  }
  return a.name.localeCompare(b.name);
}
