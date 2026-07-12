import * as crypto from 'crypto';

/**
 * Generates a strong random password: guaranteed to include a lowercase,
 * uppercase, digit and symbol, with no visually ambiguous characters.
 */
export function generateStrongPassword(length = 16): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '@#%*-_=+';
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)];

  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));

  // Fisher–Yates shuffle so the guaranteed chars aren't always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
