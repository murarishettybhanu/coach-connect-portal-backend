import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign } from '../../schemas/campaign.schema';

@Injectable()
export class CampaignsService {
  constructor(@InjectModel(Campaign.name) private campaignModel: Model<Campaign>) { }

  // Only populate products that are not soft-deleted, so deleted products drop
  // out of storefront/campaign listings. Order history uses a separate populate
  // path and is unaffected — old orders still resolve deleted products.
  private readonly activeProductPopulate = {
    path: 'products.productId',
    match: { isDeleted: { $ne: true } },
  };

  // A populate `match` sets non-matching refs to null rather than removing the
  // array entry, so strip those out to leave only live products.
  private stripDeletedProducts<T>(result: T): T {
    const strip = (campaign: any) => {
      if (campaign?.products) {
        campaign.products = campaign.products.filter((p: any) => p.productId != null);
      }
    };
    if (Array.isArray(result)) result.forEach(strip);
    else strip(result);
    return result;
  }

  async create(campaignData: any): Promise<Campaign> {
    const campaign = new this.campaignModel(campaignData);
    return campaign.save();
  }

  async findAll(): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find()
      .populate('coachId')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    return this.stripDeletedProducts(campaigns) as unknown as Campaign[];
  }

  async findByCoach(coachId: string): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find({ coachId } as any)
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    return this.stripDeletedProducts(campaigns) as unknown as Campaign[];
  }

  async findBySlug(slug: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findOne({ slug } as any)
      .populate('coachId')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with slug ${slug} not found`);
    }
    return this.stripDeletedProducts(campaign) as unknown as Campaign;
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findById(id)
      .populate('coachId')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return this.stripDeletedProducts(campaign) as unknown as Campaign;
  }

  async update(id: string, campaignData: any): Promise<Campaign> {
    const updatedCampaign = await this.campaignModel
      .findByIdAndUpdate(id, campaignData, { new: true })
      .exec();
    if (!updatedCampaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return updatedCampaign;
  }
}
