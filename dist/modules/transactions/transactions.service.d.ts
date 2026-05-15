import { Model } from 'mongoose';
import { Transaction } from '../../schemas/transaction.schema';
export declare class TransactionsService {
    private transactionModel;
    constructor(transactionModel: Model<Transaction>);
    create(transactionData: any): Promise<Transaction>;
    findAll(): Promise<Transaction[]>;
    findByCoach(coachId: string): Promise<Transaction[]>;
    getBalance(coachId: string): Promise<number>;
}
