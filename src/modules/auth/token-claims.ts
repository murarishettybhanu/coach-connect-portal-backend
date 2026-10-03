/**
 * Every JWT this API issues is signed with the same `JWT_SECRET`, so a valid
 * signature alone says nothing about what a token is *for*. These are the
 * claims that tell the two kinds apart.
 */

/** Audience on WhatsApp OTP proof tokens — never accepted as a login. */
export const OTP_PROOF_AUDIENCE = 'otp-proof';

export interface LoginTokenPayload {
  sub: string;
  email?: string;
  role?: string;
  /** User.tokenVersion at sign-in; absent on tokens issued before it existed. */
  tv?: number;
  aud?: string | string[];
  purpose?: string;
}

/**
 * True only for a login token. Anything carrying an audience or a `purpose`
 * was issued for something narrower (an OTP proof) and must not authenticate
 * a user — use this wherever a verified JWT is taken to mean "signed in".
 */
export function isLoginTokenPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<LoginTokenPayload>;
  if (p.aud !== undefined || p.purpose !== undefined) return false;
  return typeof p.sub === 'string' && p.sub.length > 0;
}
