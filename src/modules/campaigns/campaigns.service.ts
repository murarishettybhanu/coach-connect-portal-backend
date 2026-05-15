import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign } from '../../schemas/campaign.schema';

@Injectable()
export class CampaignsService {
  constructor(@InjectModel(Campaign.name) private campaignModel: Model<Campaign>) {}

  async create(campaignData: any): Promise<Campaign> {
    const campaign = new this.campaignModel(campaignData);
    return campaign.save();
  }

  async findAll(): Promise<Campaign[]> {
    return this.campaignModel.find().populate('coachId').populate('products.productId').exec();
  }

  async findByCoach(coachId: string): Promise<Campaign[]> {
    return this.campaignModel.find({ coachId } as any).populate('products.productId').exec();
  }

  async findBySlug(slug: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findOne({ slug, isActive: true } as any)
      .populate('coachId')
      .populate('products.productId')
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with slug ${slug} not found`);
    }
    return campaign;
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findById(id)
      .populate('coachId')
      .populate('products.productId')
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return campaign;
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
