import type { PricingPoint, TemplatePoint } from './whatsapp-api.service';

/**
 * Pure helpers for the WhatsApp costing report (Meta pricing + template
 * analytics). Months are calendar months in UTC — Meta's daily analytics
 * buckets start at UTC midnight.
 */

export const CATEGORIES = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
  'SERVICE',
] as const;

export type CategoryTotals = Record<string, { messages: number; cost: number }>;
export type Totals = {
  messages: number;
  cost: number;
  byCategory: CategoryTotals;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** "2026-10" → unix-second [start, end) of that UTC month, end capped at `now`. */
export function monthRange(
  month: string,
  now = new Date(),
): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const start = Date.UTC(y, mo, 1) / 1000;
  const end = Math.min(
    Date.UTC(y, mo + 1, 1) / 1000,
    Math.floor(now.getTime() / 1000),
  );
  return { start, end };
}

/** The current month and the `count - 1` before it, newest first: ["2026-10", "2026-09", …]. */
export function lastMonths(count: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  return out;
}

export function totalsOf(points: PricingPoint[]): Totals {
  const byCategory: CategoryTotals = {};
  let messages = 0;
  let cost = 0;
  for (const p of points) {
    const k = (p.pricing_category || 'OTHER').toUpperCase();
    const c = (byCategory[k] ??= { messages: 0, cost: 0 });
    c.messages += p.volume ?? 0;
    c.cost = round(c.cost + (p.cost ?? 0));
    messages += p.volume ?? 0;
    cost += p.cost ?? 0;
  }
  return { messages, cost: round(cost), byCategory };
}

/** Every UTC day of [start, end) with each category's cost and messages (zero-filled). */
export function dailySeries(
  points: PricingPoint[],
  start: number,
  end: number,
) {
  const days = new Map<string, Record<string, number>>();
  for (let t = start; t < end; t += 86400) {
    days.set(new Date(t * 1000).toISOString().slice(0, 10), {
      cost: 0,
      messages: 0,
    });
  }
  for (const p of points) {
    const day = new Date(p.start * 1000).toISOString().slice(0, 10);
    const row = days.get(day);
    if (!row) continue;
    const k = (p.pricing_category || 'OTHER').toUpperCase();
    row[k] = round((row[k] ?? 0) + (p.cost ?? 0));
    row[`${k}_messages`] = (row[`${k}_messages`] ?? 0) + (p.volume ?? 0);
    row.cost = round(row.cost + (p.cost ?? 0));
    row.messages += p.volume ?? 0;
  }
  return [...days.entries()].map(([date, v]) => ({ date, ...v }));
}

export type TemplateRow = {
  id: string;
  name: string;
  category: string;
  sent: number;
  delivered: number;
  read: number;
  clicks: number;
  cost: number;
  costPerDelivered: number | null;
};

/**
 * Per-template totals. Only `amount_spent` is money spent — Meta's cost array
 * also carries averages (cost_per_delivered, cost_per_url_button_click) that
 * must not be added in. Clicks count unique button clicks.
 */
export function templateRows(
  points: TemplatePoint[],
  templates: { id: string; name: string; category: string }[],
): TemplateRow[] {
  const meta = new Map(templates.map((t) => [t.id, t]));
  const rows = new Map<string, TemplateRow>();
  for (const p of points) {
    const t = meta.get(p.template_id);
    const r =
      rows.get(p.template_id) ??
      ({
        id: p.template_id,
        name: t?.name ?? p.template_id,
        category: t?.category ?? '',
        sent: 0,
        delivered: 0,
        read: 0,
        clicks: 0,
        cost: 0,
        costPerDelivered: null,
      } as TemplateRow);
    r.sent += p.sent ?? 0;
    r.delivered += p.delivered ?? 0;
    r.read += p.read ?? 0;
    r.clicks += (p.clicked ?? [])
      .filter((c) => c.type.startsWith('unique_'))
      .reduce((s, c) => s + (c.count ?? 0), 0);
    r.cost = round(
      r.cost +
        (p.cost ?? [])
          .filter((c) => c.type === 'amount_spent')
          .reduce((s, c) => s + (c.value ?? 0), 0),
    );
    rows.set(p.template_id, r);
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      costPerDelivered: r.delivered ? round(r.cost / r.delivered) : null,
    }))
    .filter((r) => r.sent || r.cost)
    .sort((a, b) => b.cost - a.cost || b.sent - a.sent);
}
