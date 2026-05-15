import { Model } from 'mongoose';
import { Campaign } from '../../schemas/campaign.schema';
export declare class CampaignsService {
    private campaignModel;
    constructor(campaignModel: Model<Campaign>);
    create(campaignData: any): Promise<Campaign>;
    findAll(): Promise<Campaign[]>;
    findByCoach(coachId: string): Promise<Campaign[]>;
    findBySlug(slug: string): Promise<Campaign>;
    findOne(id: string): Promise<Campaign>;
    update(id: string, campaignData: any): Promise<Campaign>;
}
