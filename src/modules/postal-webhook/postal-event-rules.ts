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

/** "2025-11-09" + "08:37:52", in IST. Falls back to now when missing/garbled. */
export function eventTime(date: string, time: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const t = /^\d{2}:\d{2}(:\d{2})?$/.test(time)
      ? time.length === 5
        ? `${time}:00`
        : time
      : '00:00:00';
    const d = new Date(`${date}T${t}+05:30`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * What an event means for the order. Matched on the code and the description,
 * since India Post's exact codes beyond ITEM_BOOK aren't documented.
 * "Item not Delivered" / non-delivery / delivery attempts are NOT deliveries.
 */
export function milestoneOf(
  eventCode: string,
  description: string,
): PostalMilestone {
  const text = `${eventCode} ${description}`
    .toUpperCase()
    .replace(/[_-]+/g, ' ');
  if (/\bRETURN/.test(text) || /\bRTS\b/.test(text)) return 'RETURNED';
  if (/\bITEM BOOK/.test(text)) return 'BOOKED';
  if (
    /\bDELIVER/.test(text) &&
    !/\b(NOT|NON|UN|UNDELIVERED|ATTEMPT\w*|INTIMATION|OUT FOR|FOR DELIVERY)\b/.test(
      text,
    )
  ) {
    return 'DELIVERED';
  }
  return null;
}
