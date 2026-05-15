import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction, TransactionType } from '../../schemas/transaction.schema';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
  ) {}

  async create(transactionData: any): Promise<Transaction> {
    const transaction = new this.transactionModel(transactionData);
    return transaction.save();
  }

  async findAll(): Promise<Transaction[]> {
    return this.transactionModel.find().populate('coachId').exec();
  }

  async findByCoach(coachId: string): Promise<Transaction[]> {
    return this.transactionModel.find({ coachId } as any).sort({ createdAt: -1 }).exec();
  }

  async getBalance(coachId: string): Promise<number> {
    const transactions = await this.transactionModel.find({ coachId } as any).exec();
    
    return transactions.reduce((acc, curr) => {
      if (curr.type === TransactionType.COMMISSION) {
        return acc + curr.amount;
      } else if (curr.type === TransactionType.PAYOUT || curr.type === TransactionType.DEBIT) {
        return acc - curr.amount;
      }
      return acc;
    }, 0);
  }
}
