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
      statusHistory: [{
        status: OrderStatus.NEW,
        at: new Date(),
        note: isWelcomeKit ? 'Order placed — awaiting approval' : 'Order placed',
      }],
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

  async approveOrder(
    id: string,
    approvedBy: string,
    note?: string,
    selectedItemIds?: string[],
  ): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    if (order.approvalStatus !== ApprovalStatus.PENDING) throw new BadRequestException('Order is not pending approval');

    const now = new Date();
    order.approvalStatus = ApprovalStatus.APPROVED;
    order.approvedBy = approvedBy;
    order.approvedAt = now;
    if (note) order.approvalNote = note;
    if (!order.statusHistory) order.statusHistory = [] as any;
    order.statusHistory.push({ status: 'APPROVED', at: now, note });

    // If a selection was provided, mark items not in the list as unselected
    // (item is kept in the order, only its `selected` flag changes).
    if (Array.isArray(selectedItemIds)) {
      const selectedSet = new Set(selectedItemIds.map(String));
      order.items.forEach((item: any) => {
        item.selected = selectedSet.has(item._id.toString());
      });
      order.markModified('items');
    }

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

    const now = new Date();
    order.approvalStatus = ApprovalStatus.REJECTED;
    order.approvedBy = rejectedBy;
    order.approvedAt = now;
    order.status = OrderStatus.CANCELLED;
    if (note) order.approvalNote = note;
    if (!order.statusHistory) order.statusHistory = [] as any;
    order.statusHistory.push({ status: 'REJECTED', at: now, note });

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

  async findByCoachPaginated(
    coachId: string,
    options: { page?: number; limit?: number; search?: string; status?: string } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: any = { coachId };

    if (options.status) {
      filter.status = options.status;
    }

    // Delivered orders sort by delivery time (newest first); fall back to creation time.
    const sort: any = options.status === OrderStatus.DELIVERED
      ? { deliveredAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const search = options.search?.trim();
    if (search) {
      // Escape regex special chars so user input is treated literally
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.email': regex },
        { 'shippingAddress.city': regex },
        { 'shippingAddress.state': regex },
        { status: regex },
        { type: regex },
        { trackingNumber: regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  // Same as findByCoachPaginated but across ALL coaches (admin Orders page).
  async findAllPaginated(
    options: { page?: number; limit?: number; search?: string; status?: string } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (options.status) {
      filter.status = options.status;
    }

    const sort: any = options.status === OrderStatus.DELIVERED
      ? { deliveredAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const search = options.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.email': regex },
        { 'shippingAddress.city': regex },
        { 'shippingAddress.state': regex },
        { status: regex },
        { type: regex },
        { trackingNumber: regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .populate({ path: 'coachId', populate: { path: 'userId', select: 'name email' } })
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    trackingNumber?: string,
  ): Promise<Order> {
    const now = new Date();
    const update: any = {
      status,
      $push: { statusHistory: { status, at: now } },
    };
    if (status === OrderStatus.DELIVERED) {
      update.deliveredAt = now;
    }
    // Persist the courier tracking number entered at dispatch time.
    if (trackingNumber) {
      update.trackingNumber = trackingNumber.trim();
    }
    const updatedOrder = await this.orderModel
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    if (!updatedOrder) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return updatedOrder;
  }
}

