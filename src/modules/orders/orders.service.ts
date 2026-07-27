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

  // Public endpoint — NEVER trust client-supplied coachId / type / prices.
  // The campaign (or the products themselves) is the source of truth; this
  // prevents forged orders that mint commission to arbitrary tribes.
  async create(orderData: any): Promise<Order> {
    const rawItems: any[] = orderData.items || [];
    if (!rawItems.length) throw new BadRequestException('Order has no items');

    // If a campaign is referenced, it dictates coach, type, and per-item prices.
    let campaign: any = null;
    if (orderData.campaignId) {
      campaign = await this.campaignModel.findById(orderData.campaignId).exec();
      if (!campaign) throw new NotFoundException('Campaign not found');
      if (campaign.status && campaign.status !== 'ACTIVE') {
        throw new BadRequestException('This campaign is not accepting orders');
      }
    }

    const type: OrderType = campaign ? campaign.type : OrderType.STORE_SALE;
    const campaignPrice = new Map<string, number>();
    if (campaign) {
      for (const cp of campaign.products || []) {
        campaignPrice.set(String(cp.productId), cp.retailPrice || 0);
      }
    }

    let coachId: string | null = campaign ? String(campaign.coachId) : null;
    let totalCommission = 0;
    let totalAmount = 0;
    let totalCost = 0;
    const itemsWithDetails: any[] = [];
    // Track atomic decrements so we can roll them back on any failure.
    const decremented: { id: string; qty: number }[] = [];

    try {
      for (const item of rawItems) {
        const product = await this.productsService.findOne(item.productId);

        // All items must belong to one tribe; derive it server-side.
        if (!coachId) coachId = String(product.coachId);
        else if (String(product.coachId) !== coachId) {
          throw new BadRequestException('All items must belong to the same tribe');
        }
        if (campaign && !campaignPrice.has(String(product._id))) {
          throw new BadRequestException('Product is not part of this campaign');
        }

        const quantity = Math.max(1, Number(item.quantity) || 1);
        // SERVER-DERIVED price — ignore whatever the client sent.
        const retailPrice =
          type === OrderType.STORE_SALE
            ? campaign
              ? campaignPrice.get(String(product._id)) || 0
              : product.retailPrice || 0
            : 0;

        let commission = 0;
        if (type === OrderType.STORE_SALE) {
          commission = (retailPrice - product.baseProductionCost) * quantity;
          totalAmount += retailPrice * quantity;
        }
        totalCost += product.baseProductionCost * quantity;
        totalCommission += commission;

        // Atomic stock check + decrement.
        const ok = await this.productsService.decrementStock(String(product._id), quantity);
        if (!ok) {
          throw new BadRequestException(`Insufficient stock for ${product.name}`);
        }
        decremented.push({ id: String(product._id), qty: quantity });

        itemsWithDetails.push({
          productId: product._id,
          quantity,
          retailPrice,
          baseCost: product.baseProductionCost,
          commission,
          ...(item.customizationType
            ? { customizationType: item.customizationType, customizationValue: item.customizationValue }
            : {}),
        });
      }
    } catch (err) {
      // Compensate: restore any stock already decremented in this attempt.
      for (const d of decremented) await this.productsService.incrementStock(d.id, d.qty);
      throw err;
    }

    if (!coachId) throw new BadRequestException('Could not resolve the tribe for this order');

    const isWelcomeKit = type === OrderType.WELCOME_KIT;

    // Explicit build — do NOT spread client orderData (mass-assignment guard).
    const order = new this.orderModel({
      coachId,
      campaignId: orderData.campaignId,
      type,
      shippingAddress: orderData.shippingAddress,
      items: itemsWithDetails,
      totalCommission,
      totalAmount,
      totalCost,
      status: OrderStatus.NEW,
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
    if (type === OrderType.STORE_SALE && totalCommission > 0) {
      await this.transactionsService.create({
        coachId,
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

    // Restore stock atomically.
    for (const item of order.items) {
      const pid = (item.productId as any)?._id || item.productId;
      await this.productsService.incrementStock(String(pid), item.quantity);
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
    return this.orderModel.find().sort({ createdAt: -1 }).populate('coachId').populate('items.productId').populate('campaignId', 'name type').exec();
  }

  async findByCoach(coachId: string): Promise<Order[]> {
    return this.orderModel.find({ coachId } as any).sort({ createdAt: -1 }).populate('items.productId').populate('campaignId', 'name type').exec();
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
        .populate('campaignId', 'name type')
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
        .populate('campaignId', 'name type')
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

