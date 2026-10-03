import { ForbiddenException } from '@nestjs/common';

/**
 * The signed-in user's id. `JwtStrategy.validate` puts the full User document
 * on `req.user`, so `_id` is the field that is actually there — the old
 * `userId || sub || _id` chain only ever resolved to it anyway.
 */
export function userIdOf(user: any): string {
  return String(user?._id ?? '');
}

/** The id behind a ref that may or may not have been populated. */
export function refIdOf(ref: any): string {
  return String(ref?._id ?? ref ?? '');
}

/**
 * Object-level authorization: throws unless `ownerRef` (a tribe ref on an
 * order, campaign, product…) is the caller's tribe.
 */
export function assertOwnedBy(
  ownerRef: any,
  tribeId: any,
  message = 'Not authorized to access this resource',
): void {
  const owner = refIdOf(ownerRef);
  if (!owner || owner !== refIdOf(tribeId)) {
    throw new ForbiddenException(message);
  }
}
