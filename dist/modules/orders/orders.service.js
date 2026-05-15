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
exports.OrdersService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const order_schema_1 = require("../../schemas/order.schema");
const campaign_schema_1 = require("../../schemas/campaign.schema");
const products_service_1 = require("../products/products.service");
const transactions_service_1 = require("../transactions/transactions.service");
const transaction_schema_1 = require("../../schemas/transaction.schema");
let OrdersService = class OrdersService {
    orderModel;
    campaignModel;
    productsService;
    transactionsService;
    constructor(orderModel, campaignModel, productsService, transactionsService) {
        this.orderModel = orderModel;
        this.campaignModel = campaignModel;
        this.productsService = productsService;
        this.transactionsService = transactionsService;
    }
    async create(orderData) {
        let totalCommission = 0;
        let totalAmount = 0;
        let totalCost = 0;
        const itemsWithDetails = await Promise.all(orderData.items.map(async (item) => {
            const product = await this.productsService.findOne(item.productId);
            let commission = 0;
            let retailPrice = item.retailPrice || 0;
            if (orderData.type === order_schema_1.OrderType.STORE_SALE) {
                commission = (retailPrice - product.baseProductionCost) * item.quantity;
                totalAmount += retailPrice * item.quantity;
            }
            totalCost += product.baseProductionCost * item.quantity;
            totalCommission += commission;
            await this.productsService.update(product._id, {
                stockLevel: Math.max(0, product.stockLevel - item.quantity),
            });
            return {
                ...item,
                baseCost: product.baseProductionCost,
                commission,
            };
        }));
        const order = new this.orderModel({
            ...orderData,
            items: itemsWithDetails,
            totalCommission,
            totalAmount,
            totalCost,
        });
        const savedOrder = await order.save();
        if (orderData.campaignId) {
            await this.campaignModel.findByIdAndUpdate(orderData.campaignId, {
                $inc: { claims: 1 }
            });
        }
        if (orderData.type === order_schema_1.OrderType.STORE_SALE && totalCommission > 0) {
            await this.transactionsService.create({
                coachId: orderData.coachId,
                type: transaction_schema_1.TransactionType.COMMISSION,
                amount: totalCommission,
                orderId: savedOrder._id,
                description: `Commission from Order #${savedOrder._id.toString().slice(-6)}`,
            });
        }
        return savedOrder;
    }
    async findAll() {
        return this.orderModel.find().sort({ createdAt: -1 }).populate('coachId').populate('items.productId').exec();
    }
    async findByCoach(coachId) {
        return this.orderModel.find({ coachId }).sort({ createdAt: -1 }).populate('items.productId').exec();
    }
    async findOne(id) {
        const order = await this.orderModel.findById(id).populate('items.productId').exec();
        if (!order) {
            throw new common_1.NotFoundException(`Order with ID ${id} not found`);
        }
        return order;
    }
    async updateStatus(id, status) {
        const updatedOrder = await this.orderModel
            .findByIdAndUpdate(id, { status }, { new: true })
            .exec();
        if (!updatedOrder) {
            throw new common_1.NotFoundException(`Order with ID ${id} not found`);
        }
        return updatedOrder;
    }
};
exports.OrdersService = OrdersService;
exports.OrdersService = OrdersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(order_schema_1.Order.name)),
    __param(1, (0, mongoose_1.InjectModel)(campaign_schema_1.Campaign.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        mongoose_2.Model,
        products_service_1.ProductsService,
        transactions_service_1.TransactionsService])
], OrdersService);
//# sourceMappingURL=orders.service.js.map