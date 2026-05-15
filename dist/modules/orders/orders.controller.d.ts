import { OrdersService } from './orders.service';
import { CoachesService } from '../coaches/coaches.service';
import { OrderStatus } from '../../schemas/order.schema';
export declare class OrdersController {
    private readonly ordersService;
    private readonly coachesService;
    constructor(ordersService: OrdersService, coachesService: CoachesService);
    findMyOrders(req: any): Promise<import("../../schemas/order.schema").Order[]>;
    create(orderData: any): Promise<import("../../schemas/order.schema").Order>;
    findAll(): Promise<import("../../schemas/order.schema").Order[]>;
    findByCoach(req: any): Promise<import("../../schemas/order.schema").Order[]>;
    findOne(id: string): Promise<import("../../schemas/order.schema").Order>;
    updateStatus(id: string, status: OrderStatus): Promise<import("../../schemas/order.schema").Order>;
}
