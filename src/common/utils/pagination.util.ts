/**
 * Upper bound on a single page of a paginated list. Admins may ask for any page
 * size up to the number of records (the table's Custom rows box), so this is
 * not a UX limit — it only stops one request from loading an unbounded result
 * set into a container with a ~320MB heap. Mirrored by PAGE_SIZE_CEILING in the
 * frontend's PageSizeControl; keep the two in step.
 */
export const MAX_PAGE_SIZE = 5000;

/** Parses a requested page size: falls back when missing, clamps to 1..MAX_PAGE_SIZE. */
export function pageSizeOf(limit: unknown, fallback: number): number {
  return Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(limit)) || fallback),
  );
}
