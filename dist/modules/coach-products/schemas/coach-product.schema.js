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
exports.CoachProductSchema = exports.CoachProduct = void 0;
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
let CoachProduct = class CoachProduct extends mongoose_2.Document {
    coachId;
    productId;
    allocatedCost;
    isActive;
};
exports.CoachProduct = CoachProduct;
__decorate([
    (0, mongoose_1.Prop)({ type: mongoose_2.Schema.Types.ObjectId, ref: 'Coach', required: true }),
    __metadata("design:type", mongoose_2.Schema.Types.ObjectId)
], CoachProduct.prototype, "coachId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: mongoose_2.Schema.Types.ObjectId, ref: 'Product', required: true }),
    __metadata("design:type", mongoose_2.Schema.Types.ObjectId)
], CoachProduct.prototype, "productId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, min: 0 }),
    __metadata("design:type", Number)
], CoachProduct.prototype, "allocatedCost", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: true }),
    __metadata("design:type", Boolean)
], CoachProduct.prototype, "isActive", void 0);
exports.CoachProduct = CoachProduct = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true })
], CoachProduct);
exports.CoachProductSchema = mongoose_1.SchemaFactory.createForClass(CoachProduct);
exports.CoachProductSchema.index({ coachId: 1, productId: 1 }, { unique: true });
//# sourceMappingURL=coach-product.schema.js.map