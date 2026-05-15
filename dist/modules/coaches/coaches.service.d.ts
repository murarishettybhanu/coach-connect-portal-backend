import { Model } from 'mongoose';
import { Coach } from '../../schemas/coach.schema';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';
export declare class CoachesService {
    private coachModel;
    private usersService;
    private transactionsService;
    constructor(coachModel: Model<Coach>, usersService: UsersService, transactionsService: TransactionsService);
    create(coachData: any): Promise<Coach>;
    findAll(): Promise<any[]>;
    findByUserId(userId: string): Promise<any>;
    findOne(id: string): Promise<any>;
    findByUsername(username: string): Promise<any>;
    update(id: string, coachData: any): Promise<Coach>;
}
