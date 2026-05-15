"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoachesService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const bcrypt = __importStar(require("bcrypt"));
const coach_schema_1 = require("../../schemas/coach.schema");
const users_service_1 = require("../users/users.service");
const transactions_service_1 = require("../transactions/transactions.service");
const user_schema_1 = require("../../schemas/user.schema");
let CoachesService = class CoachesService {
    coachModel;
    usersService;
    transactionsService;
    constructor(coachModel, usersService, transactionsService) {
        this.coachModel = coachModel;
        this.usersService = usersService;
        this.transactionsService = transactionsService;
    }
    async create(coachData) {
        const existingUser = await this.usersService.findOneByEmail(coachData.email);
        if (existingUser) {
            throw new common_1.ConflictException('A user with this email already exists');
        }
        const hashedPassword = await bcrypt.hash('coach123', 10);
        const user = await this.usersService.create({
            email: coachData.email,
            name: coachData.name,
            password: hashedPassword,
            role: user_schema_1.UserRole.COACH,
        });
        const coach = new this.coachModel({
            userId: user._id,
            username: coachData.username,
            brand: coachData.brand || coachData.name,
            walletBalance: 0,
            isActive: true,
            storefrontConfig: {},
            bankingDetails: {},
        });
        return coach.save();
    }
    async findAll() {
        const coaches = await this.coachModel.find().populate('userId', '-password').exec();
        return Promise.all(coaches.map(async (c) => {
            const balance = await this.transactionsService.getBalance(c._id);
            const coachObj = c.toObject();
            return { ...coachObj, walletBalance: balance };
        }));
    }
    async findByUserId(userId) {
        const coach = await this.coachModel.findOne({ userId }).exec();
        if (!coach) {
            throw new common_1.NotFoundException(`Coach profile for user ${userId} not found`);
        }
        const balance = await this.transactionsService.getBalance(coach._id);
        const coachObj = coach.toObject();
        return { ...coachObj, walletBalance: balance };
    }
    async findOne(id) {
        const coach = await this.coachModel.findById(id).populate('userId', '-password').exec();
        if (!coach) {
            throw new common_1.NotFoundException(`Coach with ID ${id} not found`);
        }
        const balance = await this.transactionsService.getBalance(coach._id);
        const coachObj = coach.toObject();
        return { ...coachObj, walletBalance: balance };
    }
    async findByUsername(username) {
        const coach = await this.coachModel.findOne({ username }).exec();
        if (!coach) {
            throw new common_1.NotFoundException(`Coach with username ${username} not found`);
        }
        const balance = await this.transactionsService.getBalance(coach._id);
        const coachObj = coach.toObject();
        return { ...coachObj, walletBalance: balance };
    }
    async update(id, coachData) {
        const updatedCoach = await this.coachModel
            .findByIdAndUpdate(id, coachData, { new: true })
            .exec();
        if (!updatedCoach) {
            throw new common_1.NotFoundException(`Coach with ID ${id} not found`);
        }
        return updatedCoach;
    }
};
exports.CoachesService = CoachesService;
exports.CoachesService = CoachesService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(coach_schema_1.Coach.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        users_service_1.UsersService,
        transactions_service_1.TransactionsService])
], CoachesService);
//# sourceMappingURL=coaches.service.js.map