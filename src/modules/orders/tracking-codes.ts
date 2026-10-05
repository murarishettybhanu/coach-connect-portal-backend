/**
 * Pasted barcode / tracking-number lists (admin "Mark delivered" tool).
 *
 * Codes are compared case-insensitively and without surrounding whitespace, so
 * "em123456789in " and "EM123456789IN" are the same parcel. Mirrors the
 * frontend's `lib/tracking-codes.ts`, which shows the duplicates before submit.
 */
export const MAX_TRACKING_CODES = 1000;

export const normalizeCode = (raw: string): string =>
  String(raw ?? '')
    .trim()
    .toUpperCase();

/** Unique, normalised codes in first-seen order (blanks dropped). */
export function uniqueCodes(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const r of raw) {
    const code = normalizeCode(r);
    if (code) seen.add(code);
  }
  return [...seen];
}
