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

/** The campaign filter's value for orders with no campaign (store purchases). */
export const NO_CAMPAIGN = 'none';

/**
 * Same shape for the campaign filter: one id, a comma list or repeated params,
 * plus `none` for orders that came from no campaign. Returns a condition to AND
 * into the query (it may be an `$or`, so it must not be spread over a filter
 * that has its own `$or` for search), or undefined for "every campaign".
 */
export function campaignIdsCondition(campaignId?: string | string[]) {
  if (!campaignId) return undefined;
  const values = [campaignId]
    .flat()
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) return undefined;
  const ids = values.filter((v) => v !== NO_CAMPAIGN);
  if (ids.some((id) => !isValidObjectId(id))) {
    throw new BadRequestException('Invalid campaign id');
  }
  const byId = { campaignId: { $in: ids } };
  if (!values.includes(NO_CAMPAIGN)) return byId;
  // `null` matches a missing field too.
  const none = { campaignId: null };
  return ids.length ? { $or: [byId, none] } : none;
}

/** ANDs a campaign condition into `filter` (no-op for "every campaign"). */
export function andCampaignFilter(
  filter: Record<string, any>,
  campaignId?: string | string[],
) {
  const cond = campaignIdsCondition(campaignId);
  if (cond) filter.$and = [...(filter.$and ?? []), cond];
  return filter;
}
