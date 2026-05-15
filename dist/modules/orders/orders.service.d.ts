import { Model } from 'mongoose';
import { Order, OrderStatus } from '../../schemas/order.schema';
import { Campaign } from '../../schemas/campaign.schema';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
export declare class OrdersService {
    private orderModel;
    private campaignModel;
    private productsService;
    private transactionsService;
    constructor(orderModel: Model<Order>, campaignModel: Model<Campaign>, productsService: ProductsService, transactionsService: TransactionsService);
    create(orderData: any): Promise<Order>;
    findAll(): Promise<Order[]>;
    findByCoach(coachId: string): Promise<Order[]>;
    findOne(id: string): Promise<Order>;
    updateStatus(id: string, status: OrderStatus): Promise<Order>;
}
