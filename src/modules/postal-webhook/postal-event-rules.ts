/**
 * Pure rules for India Post webhook events (Customer Integrations §13.8):
 * reading a payload and deciding what an event means for the order.
 */

export type PostalMilestone = 'BOOKED' | 'DELIVERED' | 'RETURNED' | null;

export type ParsedPostalEvent = {
  articleNumber: string;
  eventCode: string;
  description: string;
  eventAt: Date;
  office: string;
  officeId: string;
  nonDeliveryReason: string;
  raw: Record<string, unknown>;
};

const ARTICLE_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const str = (v: unknown) =>
  v === undefined || v === null ? '' : String(v).trim();

/**
 * The events in a webhook body. India Post's sample is one object; accept an
 * array, or one wrapped in `events` / `data`, too. Anything without a valid
 * article number is dropped (a portal "Test" ping, for one).
 */
export function parsePostalPayload(body: unknown): ParsedPostalEvent[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Array.isArray((body as any).events)
        ? (body as any).events
        : Array.isArray((body as any).data)
          ? (body as any).data
          : [body]
      : [];
  const out: ParsedPostalEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const articleNumber = str(e.article_number).toUpperCase();
    if (!ARTICLE_RE.test(articleNumber)) continue;
    out.push({
      articleNumber,
      eventCode: str(e.event_code).toUpperCase(),
      description: str(e.event_description),
      eventAt: eventTime(str(e.event_date), str(e.event_time)),
      office: str(e.event_office_name),
      officeId: str(e.event_office_facility_id),
      nonDeliveryReason: str(e.non_delivery_reason),
      raw: e,
    });
  }
  return out;
}

/** "2025-11-09" + "08:37:52", in IST. Missing time → midnight; missing date → today (IST). */
export function eventTime(date: string, time: string): Date {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  const t = m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}` : '00:00:00';
  // No usable date: take today's IST date (not "now"), so India Post retrying
  // the same event lands on the same instant and is recognised as a repeat.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const d = new Date(`${day}T${t}+05:30`);
  return Number.isNaN(d.getTime()) ? new Date(`${day}T00:00:00+05:30`) : d;
}

/**
 * What an event means for the order. Matched on the code and the description,
 * since India Post's exact codes beyond ITEM_BOOK aren't documented. Strict on
 * purpose — a wrong DELIVERED tells the customer their parcel arrived:
 * - anything going back to us ("Item Returned", "Delivered to sender", RTS)
 *   is RETURNED, checked first;
 * - DELIVERED needs the word "Delivered" (or the bare code ITEM_DELIVERY /
 *   DELIVERED) and none of: not / non / un- / failed / unsuccessful /
 *   attempted / intimation — and never when a non-delivery reason is given.
 *   "Delivery Office", "Out for delivery" etc. are movement, not delivery.
 */
export function milestoneOf(
  eventCode: string,
  description: string,
  nonDeliveryReason = '',
): PostalMilestone {
  const norm = (v: string) =>
    v.toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const code = norm(eventCode);
  const text = `${code} ${norm(description)}`;
  if (/\bRETURN|\bRTS\b|TO SENDER|SENT BACK/.test(text)) return 'RETURNED';
  if (/\bITEM BOOK|\bBOOKED\b/.test(text) && !/\bCANCEL/.test(text))
    return 'BOOKED';
  const negated =
    /\b(NOT|NON|UN|UNDELIVERED|FAIL\w*|UNSUCCESS\w*|ATTEMPT\w*|INTIMATION)\b/.test(
      text,
    );
  const says =
    /\bDELIVERED\b/.test(text) ||
    [
      'ITEM DELIVERY',
      'DELIVERED',
      'ITEM DELIVERED',
      'DELIVERY CONFIRMED',
    ].includes(code);
  if (says && !negated && !nonDeliveryReason.trim()) return 'DELIVERED';
  return null;
}

/**
 * Whether a scan means India Post physically has the parcel (booked, bagged,
 * received, dispatched, out for delivery …). Records made before the parcel
 * is handed over — a pickup request, pre-advice / manifest, a label — don't
 * count, so they never mark an order Dispatched.
 */
export function isMovementScan(
  eventCode: string,
  description: string,
): boolean {
  const text = `${eventCode} ${description}`
    .toUpperCase()
    .replace(/[_-]+/g, ' ');
  if (!text.trim()) return false;
  if (
    /\bPICK ?UP\b|PRE ?ADVICE|MANIFEST|REQUEST RAISED|\bLABEL\b|ORDER (CREATED|PLACED)|\bCANCEL/.test(
      text,
    )
  ) {
    return false;
  }
  if (milestoneOf(eventCode, description)) return true;
  // On hold / not delivered / intimation / attempted all mean India Post has it.
  return /\b(BOOK|BAG|DISPATCH|DESPATCH|RECEIV|TRANSIT|OUT FOR|TAKEN OUT|REDIRECT|ARRIV|SORT|FORWARD|DELIVER|INTIMATION|ATTEMPT)|HOLD/.test(
    text,
  );
}
