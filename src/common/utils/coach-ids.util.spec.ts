import { Types } from 'mongoose';
import { andCampaignFilter, campaignIdsCondition } from './coach-ids.util';

describe('campaignIdsCondition', () => {
  const a = new Types.ObjectId().toString();
  const b = new Types.ObjectId().toString();

  it('is undefined for every campaign', () => {
    expect(campaignIdsCondition()).toBeUndefined();
    expect(campaignIdsCondition(' , ')).toBeUndefined();
  });
  it('takes a comma list or repeated params', () => {
    expect(campaignIdsCondition(`${a}, ${b}`)).toEqual({
      campaignId: { $in: [a, b] },
    });
    expect(campaignIdsCondition([a, b])).toEqual({
      campaignId: { $in: [a, b] },
    });
  });
  it('"none" means orders without a campaign', () => {
    expect(campaignIdsCondition('none')).toEqual({ campaignId: null });
    expect(campaignIdsCondition(`${a},none`)).toEqual({
      $or: [{ campaignId: { $in: [a] } }, { campaignId: null }],
    });
  });
  it('rejects a malformed id', () => {
    expect(() => campaignIdsCondition('nope')).toThrow('Invalid campaign id');
  });
});

describe('andCampaignFilter', () => {
  it('ANDs alongside a search $or instead of replacing it', () => {
    const a = new Types.ObjectId().toString();
    const filter: any = { $or: [{ x: 1 }] };
    andCampaignFilter(filter, `${a},none`);
    expect(filter.$or).toEqual([{ x: 1 }]);
    expect(filter.$and).toHaveLength(1);
    expect(andCampaignFilter({}, undefined)).toEqual({});
  });
});
