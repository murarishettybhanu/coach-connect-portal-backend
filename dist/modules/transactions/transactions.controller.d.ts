import { TransactionsService } from './transactions.service';
import { CoachesService } from '../coaches/coaches.service';
export declare class TransactionsController {
    private readonly transactionsService;
    private readonly coachesService;
    constructor(transactionsService: TransactionsService, coachesService: CoachesService);
    findMyTransactions(req: any): Promise<import("../../schemas/transaction.schema").Transaction[]>;
    getMyBalance(req: any): Promise<{
        balance: number;
    }>;
    createPayout(payoutData: any): Promise<import("../../schemas/transaction.schema").Transaction>;
    findAll(): Promise<import("../../schemas/transaction.schema").Transaction[]>;
    findByCoach(req: any): Promise<import("../../schemas/transaction.schema").Transaction[]>;
    getBalance(req: any): Promise<{
        balance: number;
    }>;
}
