"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignsService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const campaign_schema_1 = require("../../schemas/campaign.schema");
let CampaignsService = class CampaignsService {
    campaignModel;
    constructor(campaignModel) {
        this.campaignModel = campaignModel;
    }
    async create(campaignData) {
        const campaign = new this.campaignModel(campaignData);
        return campaign.save();
    }
    async findAll() {
        return this.campaignModel.find().populate('coachId').populate('products.productId').exec();
    }
    async findByCoach(coachId) {
        return this.campaignModel.find({ coachId }).populate('products.productId').exec();
    }
    async findBySlug(slug) {
        const campaign = await this.campaignModel
            .findOne({ slug, isActive: true })
            .populate('coachId')
            .populate('products.productId')
            .exec();
        if (!campaign) {
            throw new common_1.NotFoundException(`Campaign with slug ${slug} not found`);
        }
        return campaign;
    }
    async findOne(id) {
        const campaign = await this.campaignModel
            .findById(id)
            .populate('coachId')
            .populate('products.productId')
            .exec();
        if (!campaign) {
            throw new common_1.NotFoundException(`Campaign with ID ${id} not found`);
        }
        return campaign;
    }
    async update(id, campaignData) {
        const updatedCampaign = await this.campaignModel
            .findByIdAndUpdate(id, campaignData, { new: true })
            .exec();
        if (!updatedCampaign) {
            throw new common_1.NotFoundException(`Campaign with ID ${id} not found`);
        }
        return updatedCampaign;
    }
};
exports.CampaignsService = CampaignsService;
exports.CampaignsService = CampaignsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(campaign_schema_1.Campaign.name)),
    __metadata("design:paramtypes", [mongoose_2.Model])
], CampaignsService);
//# sourceMappingURL=campaigns.service.js.map