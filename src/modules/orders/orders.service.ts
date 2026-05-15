import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderStatus, OrderType } from '../../schemas/order.schema';
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

    const order = new this.orderModel({
      ...orderData,
      items: itemsWithDetails,
      totalCommission,
      totalAmount,
      totalCost,
    });

    const savedOrder = await order.save();

    // Increment campaign claims if applicable
    if (orderData.campaignId) {
      await this.campaignModel.findByIdAndUpdate(orderData.campaignId, {
        $inc: { claims: 1 }
      });
    }

    // Record transactions
    if (orderData.type === OrderType.STORE_SALE && totalCommission > 0) {
      // Coach earns the margin
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
