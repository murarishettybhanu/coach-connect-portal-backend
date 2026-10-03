import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

/**
 * The admin tables filter by one tribe or several — `coachId` arrives as one
 * id, a comma-separated list, or repeated query params. Returns the Mongo
 * condition, or undefined for "every tribe". A malformed id is a 400 rather
 * than a filter that silently matches nothing.
 */
export function coachIdsFilter(coachId?: string | string[]) {
  if (!coachId) return undefined;
  const ids = [coachId]
    .flat()
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (ids.some((id) => !isValidObjectId(id))) {
    throw new BadRequestException('Invalid tribe id');
  }
  return ids.length ? { $in: ids } : undefined;
}
