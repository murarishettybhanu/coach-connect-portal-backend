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
exports.TransactionsController = void 0;
const common_1 = require("@nestjs/common");
const transactions_service_1 = require("./transactions.service");
const coaches_service_1 = require("../coaches/coaches.service");
const jwt_auth_guard_1 = require("../auth/guards/jwt-auth.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const user_schema_1 = require("../../schemas/user.schema");
let TransactionsController = class TransactionsController {
    transactionsService;
    coachesService;
    constructor(transactionsService, coachesService) {
        this.transactionsService = transactionsService;
        this.coachesService = coachesService;
    }
    async findMyTransactions(req) {
        const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
        return this.transactionsService.findByCoach(coach._id);
    }
    async getMyBalance(req) {
        const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
        const balance = await this.transactionsService.getBalance(coach._id);
        return { balance };
    }
    createPayout(payoutData) {
        return this.transactionsService.create({
            ...payoutData,
            type: 'PAYOUT',
        });
    }
    findAll() {
        return this.transactionsService.findAll();
    }
    findByCoach(req) {
        return this.findMyTransactions(req);
    }
    async getBalance(req) {
        return this.getMyBalance(req);
    }
};
exports.TransactionsController = TransactionsController;
__decorate([
    (0, common_1.Get)('me'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.COACH),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TransactionsController.prototype, "findMyTransactions", null);
__decorate([
    (0, common_1.Get)('my-balance'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.COACH),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TransactionsController.prototype, "getMyBalance", null);
__decorate([
    (0, common_1.Post)('payout'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.ADMIN),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TransactionsController.prototype, "createPayout", null);
__decorate([
    (0, common_1.Get)(),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.ADMIN),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], TransactionsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('coach'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.COACH),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TransactionsController.prototype, "findByCoach", null);
__decorate([
    (0, common_1.Get)('balance'),
    (0, roles_decorator_1.Roles)(user_schema_1.UserRole.COACH),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TransactionsController.prototype, "getBalance", null);
exports.TransactionsController = TransactionsController = __decorate([
    (0, common_1.Controller)('transactions'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard),
    __metadata("design:paramtypes", [transactions_service_1.TransactionsService,
        coaches_service_1.CoachesService])
], TransactionsController);
//# sourceMappingURL=transactions.controller.js.map