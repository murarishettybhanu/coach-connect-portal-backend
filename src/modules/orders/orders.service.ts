import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderStatus, OrderType, ApprovalStatus } from '../../schemas/order.schema';
import { Campaign } from '../../schemas/campaign.schema';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../schemas/transaction.schema';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    private productsService: ProductsService,
    private transactionsService: TransactionsService,
  ) {}

  async create(orderData: any): Promise<Order> {
    let totalCommission = 0;
    let totalAmount = 0;
    let totalCost = 0;

    const itemsWithDetails = await Promise.all(
      orderData.items.map(async (item: any) => {
        const product = await this.productsService.findOne(item.productId);
        
        let commission = 0;
        let retailPrice = item.retailPrice || 0;
        
        if (orderData.type === OrderType.STORE_SALE) {
          commission = (retailPrice - product.baseProductionCost) * item.quantity;
          totalAmount += retailPrice * item.quantity;
        }

        totalCost += product.baseProductionCost * item.quantity;
        totalCommission += commission;

        // Reduce stock level
        await this.productsService.update(product._id as any, {
          stockLevel: Math.max(0, product.stockLevel - item.quantity),
        });

        return {
          ...item,
          baseCost: product.baseProductionCost,
          commission,
        };
      }),
    );

    // Welcome Kit orders require approval before entering the pipeline
    const isWelcomeKit = orderData.type === OrderType.WELCOME_KIT;

    const order = new this.orderModel({
      ...orderData,
      items: itemsWithDetails,
      totalCommission,
      totalAmount,
      totalCost,
      approvalStatus: isWelcomeKit ? ApprovalStatus.PENDING : null,
    });

    const savedOrder = await order.save();

    // Increment campaign claims if applicable
    if (orderData.campaignId) {
      await this.campaignModel.findByIdAndUpdate(orderData.campaignId, {
        $inc: { claims: 1 }
      });
    }

    // Record transactions only for store sales (welcome kits deferred until approval)
    if (orderData.type === OrderType.STORE_SALE && totalCommission > 0) {
      await this.transactionsService.create({
        coachId: orderData.coachId,
        type: TransactionType.COMMISSION,
        amount: totalCommission,
        orderId: savedOrder._id as any,
        description: `Commission from Order #${savedOrder._id.toString().slice(-6)}`,
      });
    }

    return savedOrder;
  }

  async approveOrder(id: string, approvedBy: string, note?: string): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    if (order.approvalStatus !== ApprovalStatus.PENDING) throw new BadRequestException('Order is not pending approval');

    order.approvalStatus = ApprovalStatus.APPROVED;
    order.approvedBy = approvedBy;
    order.approvedAt = new Date();
    if (note) order.approvalNote = note;

    const savedOrder = await order.save();

    // Record commission transaction on approval if applicable
    if (order.totalCommission > 0) {
      await this.transactionsService.create({
        coachId: order.coachId as any,
        type: TransactionType.COMMISSION,
        amount: order.totalCommission,
        orderId: savedOrder._id as any,
        description: `Commission from Approved Kit Order #${savedOrder._id.toString().slice(-6)}`,
      });
    }

    return savedOrder;
  }

  async rejectOrder(id: string, rejectedBy: string, note?: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    if (order.approvalStatus !== ApprovalStatus.PENDING) throw new BadRequestException('Order is not pending approval');

    order.approvalStatus = ApprovalStatus.REJECTED;
    order.approvedBy = rejectedBy;
    order.approvedAt = new Date();
    order.status = OrderStatus.CANCELLED;
    if (note) order.approvalNote = note;

    // Restore stock
    for (const item of order.items) {
      await this.productsService.update(item.productId as any, {
        $inc: { stockLevel: item.quantity },
      });
    }

    return order.save();
  }

  async findPendingApprovals(coachId?: string): Promise<Order[]> {
    const filter: any = { approvalStatus: ApprovalStatus.PENDING };
    if (coachId) filter.coachId = coachId;
    return this.orderModel.find(filter)
      .sort({ createdAt: -1 })
      .populate('coachId')
      .populate('items.productId')
      .exec();
  }

  async findAll(): Promise<Order[]> {
    return this.orderModel.find().sort({ createdAt: -1 }).populate('coachId').populate('items.productId').exec();
  }

  async findByCoach(coachId: string): Promise<Order[]> {
    return this.orderModel.find({ coachId } as any).sort({ createdAt: -1 }).populate('items.productId').exec();
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    const updatedOrder = await this.orderModel
      .findByIdAndUpdate(id, { status }, { new: true })
      .exec();
    if (!updatedOrder) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return updatedOrder;
  }
}

