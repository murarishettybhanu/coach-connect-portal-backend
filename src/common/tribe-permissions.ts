/**
 * What a tribe owner can see and do in the Tribe Portal, granted per tribe by
 * an admin (admin tribe page → Permissions). Each permission is OFF unless its
 * default says otherwise, so a new feature stays hidden until switched on.
 *
 * To add one: add it here, add the same key to UpdateTribePermissionsDto, to
 * the frontend list in src/lib/tribe-permissions.ts (label + description), and
 * enforce it on the server where the feature's data is served.
 */
export const TRIBE_PERMISSIONS = [
  {
    key: 'members',
    // The "Tribe Members" page: customers' names, phones and addresses.
    default: false,
  },
  {
    key: 'campaigns',
    // Creating, editing, pausing and stopping their own campaigns. Off makes
    // the tribe's Campaigns page read-only (admins still manage them).
    default: true,
  },
  {
    key: 'storefront',
    // The public storefront (/s/:username) and its checkout. Campaign claim
    // forms are unaffected.
    default: true,
  },
  {
    key: 'analytics',
    // The Analytics dashboard (GET /analytics/tribe).
    default: false,
  },
] as const;

export type TribePermissionKey = (typeof TRIBE_PERMISSIONS)[number]['key'];
export type TribePermissions = Record<TribePermissionKey, boolean>;

/** A tribe's effective permissions: what's stored, defaults for the rest. */
export function resolvePermissions(stored: unknown): TribePermissions {
  const s =
    stored && typeof stored === 'object'
      ? (stored as Record<string, unknown>)
      : {};
  const out = {} as TribePermissions;
  for (const p of TRIBE_PERMISSIONS) {
    out[p.key] =
      typeof s[p.key] === 'boolean' ? (s[p.key] as boolean) : p.default;
  }
  return out;
}
