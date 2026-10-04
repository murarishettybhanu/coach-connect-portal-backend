/**
 * The storefront design options a tribe can pick. The frontend keeps the same
 * lists in src/lib/storefront-theme.ts — keep them in step (a font missing
 * there would save but never load; one missing here would be refused).
 */

// Curated Google Fonts — loaded on demand by the storefront / claim forms.
export const STOREFRONT_FONTS = [
  'Inter',
  'Poppins',
  'Montserrat',
  'DM Sans',
  'Nunito',
  'Space Grotesk',
  'Fraunces',
  'Playfair Display',
  'Lora',
  'Merriweather',
] as const;

export const STOREFRONT_RADII = ['sharp', 'soft', 'round'] as const;
export const STOREFRONT_BUTTON_STYLES = ['filled', 'outline', 'pill'] as const;

// #RRGGBB only: one unambiguous form for storage, contrast maths and CSS.
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
