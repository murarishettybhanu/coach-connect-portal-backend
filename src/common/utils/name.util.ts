/**
 * Title-cases a person's name for customer-facing text.
 *
 * Names arrive from public forms and CSV imports as whatever the customer or
 * the importer typed — "RAVI KUMAR", "ravi kumar", "Ravi  Kumar" — and get
 * interpolated straight into WhatsApp messages, where shouting at someone by
 * name reads badly.
 *
 * Capitalises after every separator, not just spaces, so hyphens, apostrophes
 * and initials come out right: "sri-ram" → "Sri-Ram", "d'souza" → "D'Souza",
 * "k.v. ramana" → "K.V. Ramana".
 *
 * A word that already carries an internal capital is left alone, so a
 * deliberately-cased "McDonald" or "DeSouza" survives; a fully-uppercase word
 * can't be told apart from shouting, so "MCDONALD" does become "Mcdonald".
 * Scripts without letter case (Devanagari, Telugu…) pass through unchanged.
 */
export function titleCaseName(value?: string | null): string {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';

  // Split on separators but keep them, so the original punctuation is rebuilt.
  return trimmed
    .split(/([\s\-'’.]+)/)
    .map((segment) =>
      /^[\s\-'’.]+$/.test(segment) ? segment : capitalize(segment),
    )
    .join('');
}

function capitalize(segment: string): string {
  if (!segment) return segment;

  // A one- or two-letter all-caps token is initials, not shouting — "ARUN NN"
  // should keep its NN rather than become "Nn". Common in Indian names, where
  // initials are often written without dots.
  if (segment.length <= 2 && segment === segment.toUpperCase()) return segment;

  const rest = segment.slice(1);
  const alreadyCased =
    /\p{Lu}/u.test(rest) && segment !== segment.toUpperCase();
  const head = segment.charAt(0).toUpperCase();
  return alreadyCased ? head + rest : head + rest.toLowerCase();
}
