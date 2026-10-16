import { Types } from 'mongoose';

/**
 * Admin "Advanced search" on the order lists: many pasted values at once —
 * phone numbers, tracking numbers, order ids (full or the 8-character short id
 * the tables show), emails, pincodes. An order matches if it matches ANY value;
 * that is ANDed with the list's other filters. Mirrors the frontend's
 * `lib/advanced-search.ts` (same classification), which previews the values
 * before they're sent.
 */

export const MAX_LOOKUP_VALUES = 500;

export type LookupKind =
  | 'phone'
  | 'tracking'
  | 'orderId'
  | 'shortId'
  | 'email'
  | 'pincode';
export type LookupToken = { raw: string; kind: LookupKind; value: string };
export type ParsedLookup = { tokens: LookupToken[]; unknown: string[] };

const TRACKING_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/i;
// A spaced value is kept whole only when it's made of phone characters ("+91 98765 43210").
const PHONE_CHARS_RE = /^[+\d\s().-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A phone number's last 10 digits (an Indian mobile), or null. */
function phoneOf(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  const ten =
    d.length === 10
      ? d
      : d.length === 12 && d.startsWith('91')
        ? d.slice(2)
        : d.length === 11 && d.startsWith('0')
          ? d.slice(1)
          : '';
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export function classify(raw: string): LookupToken | null {
  const t = raw.trim().replace(/^#/, '');
  if (!t) return null;
  if (EMAIL_RE.test(t)) return { raw, kind: 'email', value: t.toLowerCase() };
  if (TRACKING_RE.test(t))
    return { raw, kind: 'tracking', value: t.toUpperCase() };
  if (/^[a-f0-9]{24}$/i.test(t))
    return { raw, kind: 'orderId', value: t.toLowerCase() };
  if (/^[a-f0-9]{8}$/i.test(t))
    return { raw, kind: 'shortId', value: t.toLowerCase() };
  if (/^\d{6}$/.test(t)) return { raw, kind: 'pincode', value: t };
  const phone = phoneOf(t);
  if (phone) return { raw, kind: 'phone', value: phone };
  return null;
}

/**
 * Splits pasted text into values — lines, commas, semicolons, tabs; spaces too,
 * except inside a phone number ("+91 98765 43210" stays one) — and classifies
 * each. Duplicates (same kind and value) are dropped.
 */
export function parseLookup(text: string | string[] | undefined): ParsedLookup {
  const input = Array.isArray(text) ? text.join('\n') : String(text ?? '');
  const tokens: LookupToken[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const tok = classify(raw);
    if (!tok) {
      if (raw.trim()) unknown.push(raw.trim());
      return;
    }
    const key = `${tok.kind}:${tok.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(tok);
  };
  for (const piece of input.split(/[\n\r,;\t]+/)) {
    const p = piece.trim();
    if (!p) continue;
    if (/\s/.test(p) && PHONE_CHARS_RE.test(p) && classify(p)?.kind === 'phone')
      push(p);
    else p.split(/\s+/).forEach(push);
  }
  return { tokens, unknown };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `$or` that matches any of the values (null when there are none). */
export function lookupCondition(
  tokens: LookupToken[],
): Record<string, unknown> | null {
  const of = (k: LookupKind) =>
    tokens.filter((t) => t.kind === k).map((t) => t.value);
  const or: Record<string, unknown>[] = [];
  const phones = of('phone');
  // Stored as typed: "+91 98765 43210", "09876543210" — match the last 10 digits.
  if (phones.length)
    or.push({
      'shippingAddress.phone': {
        $in: phones.map((p) => new RegExp(`${p.split('').join('\\D*')}\\D*$`)),
      },
    });
  const tracking = of('tracking');
  if (tracking.length)
    or.push({
      trackingNumber: {
        $in: tracking.map((c) => new RegExp(`^\\s*${c}\\s*$`, 'i')),
      },
    });
  const ids = of('orderId');
  if (ids.length)
    or.push({ _id: { $in: ids.map((i) => new Types.ObjectId(i)) } });
  const short = of('shortId');
  if (short.length)
    or.push({
      $expr: { $in: [{ $substrCP: [{ $toString: '$_id' }, 16, 8] }, short] },
    });
  const emails = of('email');
  if (emails.length)
    or.push({
      'shippingAddress.email': {
        $in: emails.map((e) => new RegExp(`^\\s*${escape(e)}\\s*$`, 'i')),
      },
    });
  const pins = of('pincode');
  if (pins.length)
    or.push({
      'shippingAddress.pincode': { $in: [...pins, ...pins.map(Number)] },
    });
  return or.length ? { $or: or } : null;
}

/** ANDs the lookup onto a find() filter. */
export function andLookup(filter: any, tokens: LookupToken[]): void {
  const cond = lookupCondition(tokens);
  if (!cond) return;
  filter.$and = [...(filter.$and ?? []), cond];
}

type Matched = {
  _id: unknown;
  trackingNumber?: string;
  shippingAddress?: {
    phone?: string;
    email?: string;
    pincode?: string | number;
  };
};

/** Which values matched none of `orders` (the full matched set, not one page). */
export function unmatchedValues(
  tokens: LookupToken[],
  orders: Matched[],
): string[] {
  const phones = new Set<string>();
  const tracking = new Set<string>();
  const ids = new Set<string>();
  const emails = new Set<string>();
  const pins = new Set<string>();
  for (const o of orders) {
    const p = phoneOf(String(o.shippingAddress?.phone ?? ''));
    if (p) phones.add(p);
    if (o.trackingNumber)
      tracking.add(String(o.trackingNumber).trim().toUpperCase());
    ids.add(String(o._id).toLowerCase());
    if (o.shippingAddress?.email)
      emails.add(String(o.shippingAddress.email).trim().toLowerCase());
    if (o.shippingAddress?.pincode != null)
      pins.add(String(o.shippingAddress.pincode).trim());
  }
  const hit = (t: LookupToken) => {
    switch (t.kind) {
      case 'phone':
        return phones.has(t.value);
      case 'tracking':
        return tracking.has(t.value);
      case 'orderId':
        return ids.has(t.value);
      case 'shortId':
        return [...ids].some((id) => id.endsWith(t.value));
      case 'email':
        return emails.has(t.value);
      case 'pincode':
        return pins.has(t.value);
    }
  };
  return tokens.filter((t) => !hit(t)).map((t) => t.raw.trim());
}

export type LookupReport = {
  values: number;
  unknown: string[];
  unmatched: string[];
};
