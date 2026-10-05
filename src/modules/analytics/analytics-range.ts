// Date range + bucket maths for the tribe analytics dashboard. Pure functions,
// fixed by the shared contract (feat/tribe-analytics): days, weeks (Monday)
// and months are IST calendar units. IST is UTC+05:30 with no DST, so a fixed
// offset is exact — the database side uses $dateTrunc with the same zone.
import { BadRequestException } from '@nestjs/common';

export const TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Granularity = 'day' | 'week' | 'month';
export const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];

/** Default range: the last 30 days including today. */
export const DEFAULT_DAYS = 30;
/** Longest range accepted, in calendar days (inclusive). */
export const MAX_SPAN_DAYS = 400;
/** Auto granularity: day up to 45 days, week up to 180, else month. */
export const DAY_MAX_SPAN = 45;
export const WEEK_MAX_SPAN = 180;

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

// A calendar date is kept as its UTC-midnight Date ("day number" maths only);
// it never stands for an instant.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value: string, field: string): Date {
  const m = DATE_RE.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!d || isNaN(d.getTime()) || fmt(d) !== value) {
    throw new BadRequestException(`${field} must be a date (YYYY-MM-DD)`);
  }
  return d;
}

/** 'YYYY-MM-DD' of a calendar date. */
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** Today's IST calendar date. */
export function istToday(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/** The instant an IST calendar date starts (00:00 IST). */
export const istStart = (d: Date) => new Date(d.getTime() - IST_OFFSET_MS);

/** The IST calendar date of an instant (e.g. a $dateTrunc result). */
export const istDateKey = (instant: Date) =>
  fmt(new Date(new Date(instant).getTime() + IST_OFFSET_MS));

export function defaultGranularity(spanDays: number): Granularity {
  if (spanDays <= DAY_MAX_SPAN) return 'day';
  if (spanDays <= WEEK_MAX_SPAN) return 'week';
  return 'month';
}

export interface ResolvedRange {
  from: string;
  to: string;
  granularity: Granularity;
  /** Calendar days in the range, both ends included. */
  spanDays: number;
  /** 00:00 IST on `from`. */
  start: Date;
  /** 00:00 IST the day after `to` (exclusive end = up to 23:59:59.999 IST). */
  end: Date;
}

/**
 * Resolves the query's range. Missing `to` = today (IST); missing `from` =
 * 29 days before `to`. 400 on a bad date, from > to, a span over 400 days or
 * an unknown granularity.
 */
export function resolveRange(
  q: { from?: string; to?: string; granularity?: string },
  now: Date,
): ResolvedRange {
  const to = q.to ? parseDate(q.to, 'to') : istToday(now);
  const from = q.from
    ? parseDate(q.from, 'from')
    : addDays(to, -(DEFAULT_DAYS - 1));
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('from must be on or before to');
  }
  const spanDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (spanDays > MAX_SPAN_DAYS) {
    throw new BadRequestException(
      `The range can be at most ${MAX_SPAN_DAYS} days`,
    );
  }
  let granularity: Granularity;
  if (q.granularity) {
    if (!GRANULARITIES.includes(q.granularity as Granularity)) {
      throw new BadRequestException('granularity must be day, week or month');
    }
    granularity = q.granularity as Granularity;
  } else {
    granularity = defaultGranularity(spanDays);
  }
  return {
    from: fmt(from),
    to: fmt(to),
    granularity,
    spanDays,
    start: istStart(from),
    end: istStart(addDays(to, 1)),
  };
}

/** The start (IST calendar date) of the bucket a date falls in. */
export function bucketStart(d: Date, g: Granularity): Date {
  if (g === 'day') return d;
  if (g === 'week') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return addDays(d, -dow);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function nextBucket(d: Date, g: Granularity): Date {
  if (g === 'day') return addDays(d, 1);
  if (g === 'week') return addDays(d, 7);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** '05 Oct' | 'Wk of 29 Sep' | 'Oct 2026'. */
export function bucketLabel(d: Date, g: Granularity): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  if (g === 'day') return `${dd} ${mon}`;
  if (g === 'week') return `Wk of ${dd} ${mon}`;
  return `${mon} ${d.getUTCFullYear()}`;
}

/**
 * Every bucket touching [from, to], in order. The first week/month bucket
 * starts on its own Monday / 1st, which may be before `from`.
 */
export function buckets(
  from: string,
  to: string,
  g: Granularity,
): { bucket: string; label: string }[] {
  const last = parseDate(to, 'to');
  const out: { bucket: string; label: string }[] = [];
  for (
    let b = bucketStart(parseDate(from, 'from'), g);
    b.getTime() <= last.getTime();
    b = nextBucket(b, g)
  ) {
    out.push({ bucket: fmt(b), label: bucketLabel(b, g) });
  }
  return out;
}

/** a / b in 0–1 with 4 decimals; 0 when b is 0. */
export function rate(a: number, b: number): number {
  if (!b || b <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, a / b)) * 10_000) / 10_000;
}
