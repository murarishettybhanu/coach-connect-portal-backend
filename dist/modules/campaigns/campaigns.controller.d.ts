import { CampaignsService } from './campaigns.service';
import { CoachesService } from '../coaches/coaches.service';
export declare class CampaignsController {
    private readonly campaignsService;
    private readonly coachesService;
    constructor(campaignsService: CampaignsService, coachesService: CoachesService);
    findMyCampaigns(req: any): Promise<import("../../schemas/campaign.schema").Campaign[]>;
    create(campaignData: any): Promise<import("../../schemas/campaign.schema").Campaign>;
    findAll(): Promise<import("../../schemas/campaign.schema").Campaign[]>;
    findBySlug(slug: string): Promise<import("../../schemas/campaign.schema").Campaign>;
    findOne(id: string): Promise<import("../../schemas/campaign.schema").Campaign>;
    update(id: string, campaignData: any): Promise<import("../../schemas/campaign.schema").Campaign>;
}
