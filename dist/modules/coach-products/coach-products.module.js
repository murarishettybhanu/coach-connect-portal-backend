"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoachProductsModule = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const coach_products_service_1 = require("./coach-products.service");
const coach_products_controller_1 = require("./coach-products.controller");
const coach_product_schema_1 = require("./schemas/coach-product.schema");
let CoachProductsModule = class CoachProductsModule {
};
exports.CoachProductsModule = CoachProductsModule;
exports.CoachProductsModule = CoachProductsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([{ name: coach_product_schema_1.CoachProduct.name, schema: coach_product_schema_1.CoachProductSchema }]),
        ],
        providers: [coach_products_service_1.CoachProductsService],
        controllers: [coach_products_controller_1.CoachProductsController],
        exports: [coach_products_service_1.CoachProductsService],
    })
], CoachProductsModule);
//# sourceMappingURL=coach-products.module.js.map