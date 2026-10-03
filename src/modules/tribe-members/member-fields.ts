import type { MemberAddress } from '../../schemas/tribe-member.schema';

/**
 * Pure helpers that turn a member's orders into the member's stored fields.
 * Shared by TribeMembersService (live sync) and the backfill script (dry run),
 * so both always agree on what a member should look like.
 */

/** A member's phone: digits only, last 10 (strips +91 / 0 / spaces). '' if none. */
export function normalizePhone(phone: unknown): string {
  return String(phone ?? '')
    .replace(/\D/g, '')
    .slice(-10);
}

const squash = (v: unknown) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** Two addresses are the same address when line 1 and the pincode match, loosely. */
export function addressKey(a: {
  addressLine1?: unknown;
  pincode?: unknown;
}): string {
  return `${squash(a.addressLine1)}|${squash(a.pincode)}`;
}

const text = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  return s ? s : undefined;
};

/** The order fields buildMemberFields reads. */
export interface MemberOrder {
  _id?: any;
  createdAt?: Date | string;
  isDeleted?: boolean;
  addressPending?: boolean;
  shippingAddress?: Record<string, any>;
}

export interface MemberFields {
  name: string;
  email: string | null;
  alternatePhone: string | null;
  addresses: MemberAddress[];
  orderCount: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  // When the member joined the tribe: their earliest linked order, deleted ones
  // included (a member always has one). The member list sorts on it.
  joinedAt: Date | null;
}

const orderDate = (o: MemberOrder): Date => {
  if (o.createdAt) return new Date(o.createdAt);
  // Every order has timestamps, but an ObjectId carries its own creation time.
  if (o._id?.getTimestamp) return o._id.getTimestamp();
  return new Date(0);
};

/** Whether an order carries a complete delivery address (address-pending ones don't). */
export function hasFullAddress(o: MemberOrder): boolean {
  const a = o.shippingAddress || {};
  return (
    !o.addressPending &&
    !!text(a.addressLine1) &&
    !!text(a.city) &&
    !!text(a.state) &&
    !!text(a.pincode)
  );
}

/**
 * The member's fields from ALL of its linked orders. Contact details and
 * addresses come from every linked order, latest non-empty value winning;
 * orderCount / firstOrderAt / lastOrderAt count only orders that are not
 * soft-deleted (rejected ones still count); joinedAt is the earliest of all.
 */
export function buildMemberFields(orders: MemberOrder[]): MemberFields {
  const sorted = [...orders].sort(
    (a, b) =>
      orderDate(a).getTime() - orderDate(b).getTime() ||
      String(a._id ?? '').localeCompare(String(b._id ?? '')),
  );

  let name = '';
  let email: string | null = null;
  let alternatePhone: string | null = null;
  const byKey = new Map<string, MemberAddress>();
  let orderCount = 0;
  let firstOrderAt: Date | null = null;
  let lastOrderAt: Date | null = null;

  for (const o of sorted) {
    const a = o.shippingAddress || {};
    const at = orderDate(o);
    name = text(a.fullName) ?? name;
    email = text(a.email) ?? email;
    alternatePhone = text(a.alternatePhone) ?? alternatePhone;

    if (hasFullAddress(o)) {
      const addr: MemberAddress = {
        addressLine1: text(a.addressLine1)!,
        ...(text(a.addressLine2) ? { addressLine2: text(a.addressLine2) } : {}),
        ...(text(a.landmark) ? { landmark: text(a.landmark) } : {}),
        ...(text(a.sectorVillage)
          ? { sectorVillage: text(a.sectorVillage) }
          : {}),
        city: text(a.city)!,
        ...(text(a.district) ? { district: text(a.district) } : {}),
        state: text(a.state)!,
        pincode: text(a.pincode)!,
        lastUsedAt: at,
      };
      // Chronological, so the latest spelling of an address replaces older ones.
      const key = addressKey(addr);
      byKey.delete(key);
      byKey.set(key, addr);
    }

    if (!o.isDeleted) {
      orderCount++;
      if (!firstOrderAt) firstOrderAt = at;
      lastOrderAt = at;
    }
  }

  const addresses = [...byKey.values()].sort(
    (x, y) => y.lastUsedAt.getTime() - x.lastUsedAt.getTime(),
  );
  return {
    name,
    email,
    alternatePhone,
    addresses,
    orderCount,
    firstOrderAt,
    lastOrderAt,
    joinedAt: sorted.length ? orderDate(sorted[0]) : null,
  };
}

const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null);

const ADDRESS_FIELDS = [
  'addressLine1',
  'addressLine2',
  'landmark',
  'sectorVillage',
  'city',
  'district',
  'state',
  'pincode',
] as const;

/** A stable comparison form, so an unchanged member is never rewritten. */
function comparable(m: any): string {
  return JSON.stringify({
    name: m?.name ?? '',
    email: m?.email ?? null,
    alternatePhone: m?.alternatePhone ?? null,
    orderCount: m?.orderCount ?? 0,
    firstOrderAt: iso(m?.firstOrderAt),
    lastOrderAt: iso(m?.lastOrderAt),
    joinedAt: iso(m?.joinedAt),
    addresses: (m?.addresses ?? []).map((a: any) => [
      ...ADDRESS_FIELDS.map((f) => a?.[f] ?? null),
      iso(a?.lastUsedAt),
    ]),
  });
}

/** Whether a stored member already holds exactly these fields. */
export function sameMemberFields(stored: any, fields: MemberFields): boolean {
  return comparable(stored) === comparable(fields);
}

/** The $set / $unset that writes these fields onto a member. */
export function memberUpdate(fields: MemberFields) {
  const $set: Record<string, any> = {
    name: fields.name,
    addresses: fields.addresses,
    orderCount: fields.orderCount,
  };
  const $unset: Record<string, 1> = {};
  for (const k of [
    'email',
    'alternatePhone',
    'firstOrderAt',
    'lastOrderAt',
    'joinedAt',
  ] as const) {
    if (fields[k] == null) $unset[k] = 1;
    else $set[k] = fields[k];
  }
  return Object.keys($unset).length ? { $set, $unset } : { $set };
}
