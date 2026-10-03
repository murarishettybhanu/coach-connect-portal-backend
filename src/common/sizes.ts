// What a sized product offers when it defines no sizes of its own. Mirrors the
// frontend's lib/sizes.ts — keep the two in step.
export const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// Label for stock that hasn't been counted into a size yet.
export const UNASSIGNED = 'Unassigned';

type Sized = {
  customizationType?: string;
  sizeOptions?: string[];
  sizeStock?: { size: string; qty: number }[];
};

export const offeredSizes = (p: Sized): string[] =>
  p.sizeOptions?.length ? p.sizeOptions : DEFAULT_SIZES;

// Resolve a size as typed on an order or CSV ("m", " M ") to the product's own
// spelling of it. Null when the product isn't sized or doesn't know that size —
// that stock then counts against Unassigned.
export function matchSize(p: Sized, raw?: string | null): string | null {
  if (p.customizationType !== 'SIZE' || !raw) return null;
  const want = String(raw).trim().toUpperCase();
  if (!want) return null;
  const known = [...(p.sizeStock || []).map((s) => s.size), ...offeredSizes(p)];
  return known.find((s) => s.trim().toUpperCase() === want) ?? null;
}
