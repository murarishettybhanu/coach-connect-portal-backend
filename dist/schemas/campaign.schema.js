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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignSchema = exports.Campaign = exports.CampaignType = void 0;
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
var CampaignType;
(function (CampaignType) {
    CampaignType["WELCOME_KIT"] = "WELCOME_KIT";
    CampaignType["STORE_SALE"] = "STORE_SALE";
})(CampaignType || (exports.CampaignType = CampaignType = {}));
let Campaign = class Campaign extends mongoose_2.Document {
    coachId;
    name;
    type;
    products;
    slug;
    isActive;
    description;
    claims;
};
exports.Campaign = Campaign;
__decorate([
    (0, mongoose_1.Prop)({ type: mongoose_2.Schema.Types.ObjectId, ref: 'Coach', required: true }),
    __metadata("design:type", mongoose_2.Schema.Types.ObjectId)
], Campaign.prototype, "coachId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], Campaign.prototype, "name", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: CampaignType }),
    __metadata("design:type", String)
], Campaign.prototype, "type", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [{
                productId: { type: mongoose_2.Schema.Types.ObjectId, ref: 'Product' },
                retailPrice: Number,
            }] }),
    __metadata("design:type", Array)
], Campaign.prototype, "products", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, unique: true }),
    __metadata("design:type", String)
], Campaign.prototype, "slug", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: true }),
    __metadata("design:type", Boolean)
], Campaign.prototype, "isActive", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], Campaign.prototype, "description", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: 0 }),
    __metadata("design:type", Number)
], Campaign.prototype, "claims", void 0);
exports.Campaign = Campaign = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true })
], Campaign);
exports.CampaignSchema = mongoose_1.SchemaFactory.createForClass(Campaign);
//# sourceMappingURL=campaign.schema.js.map