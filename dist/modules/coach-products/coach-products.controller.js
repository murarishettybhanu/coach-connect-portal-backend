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
exports.CoachProductsController = void 0;
const common_1 = require("@nestjs/common");
const coach_products_service_1 = require("./coach-products.service");
const jwt_auth_guard_1 = require("../auth/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const user_schema_1 = require("../../schemas/user.schema");
let CoachProductsController = class CoachProductsController {
    coachProductsService;
    constructor(coachProductsService) {
        this.coachProductsService = coachProductsService;
    }
    allot(data) {
        return this.coachProductsService.allot(data);
    }
    findByCoach(coachId) {
        return this.coachProductsService.findByCoach(coachId);
    }
    remove(id) {
        return this.coachProductsService.remove(id);
    }
};
exports.CoachProductsController = CoachProductsController;
__decorate([
    (0, common_1.Post)('allot'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.ADMIN),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CoachProductsController.prototype, "allot", null);
__decorate([
    (0, common_1.Get)('coach/:coachId'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.ADMIN, user_schema_1.UserRole.COACH),
    __param(0, (0, common_1.Param)('coachId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CoachProductsController.prototype, "findByCoach", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.ADMIN),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CoachProductsController.prototype, "remove", null);
exports.CoachProductsController = CoachProductsController = __decorate([
    (0, common_1.Controller)('coach-products'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    __metadata("design:paramtypes", [coach_products_service_1.CoachProductsService])
], CoachProductsController);
//# sourceMappingURL=coach-products.controller.js.map