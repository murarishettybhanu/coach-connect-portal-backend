import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Transaction, TransactionType } from '../../schemas/transaction.schema';

const toObjectId = (id: any) =>
  id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));

// Signed amount for the balance: commission adds, payouts and debits subtract.
// A reversal is a COMMISSION row with a negative amount, so it nets out here
// and in every "lifetime earned" sum without a new type.
const SIGNED_AMOUNT = {
  $cond: [
    { $eq: ['$type', TransactionType.COMMISSION] },
    '$amount',
    {
      $cond: [
        { $in: ['$type', [TransactionType.PAYOUT, TransactionType.DEBIT]] },
        { $multiply: ['$amount', -1] },
        0,
      ],
    },
  ],
};

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
  ) {}

  async create(transactionData: any): Promise<Transaction> {
    const transaction = new this.transactionModel(transactionData);
    return transaction.save();
  }

  /**
   * Payout with a balance guard so an admin can't drive a tribe negative.
   *
   * No multi-document transactions (dev runs a standalone mongod), so the
   * guard is check → insert → re-check: two payouts racing each other both
   * land, the re-check sees the overdraft, and the one that caused it removes
   * itself. Worst case both back out and the admin retries — never a negative
   * balance that sticks. The UTR is unique, so re-submitting the same bank
   * transfer is refused rather than paid twice.
   */
  async createPayout(data: {
    coachId: string;
    amount: number;
    utrReference?: string;
    description?: string;
  }): Promise<Transaction> {
    const utrReference = data.utrReference?.trim() || undefined;
    if (utrReference && (await this.transactionModel.exists({ utrReference } as any))) {
      throw new ConflictException(
        `A payout with UTR ${utrReference} has already been recorded`,
      );
    }

    const balance = await this.getBalance(data.coachId);
    if (data.amount > balance) {
      throw new BadRequestException(
        `Payout of ${data.amount} exceeds available balance of ${balance}`,
      );
    }

    let payout: Transaction;
    try {
      payout = await this.create({
        coachId: data.coachId,
        type: TransactionType.PAYOUT,
        amount: data.amount,
        utrReference,
        description: data.description || 'Payout',
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A payout with UTR ${utrReference} has already been recorded`,
        );
      }
      throw err;
    }

    const after = await this.getBalance(data.coachId);
    if (after < 0) {
      await this.transactionModel.deleteOne({ _id: payout._id } as any).exec();
      throw new ConflictException(
        'The balance changed while this payout was being recorded — check it and try again',
      );
    }
    return payout;
  }

  async findAll(): Promise<Transaction[]> {
    return this.transactionModel.find().populate('coachId').exec();
  }

  async findByCoach(coachId: string): Promise<Transaction[]> {
    return this.transactionModel.find({ coachId } as any).sort({ createdAt: -1 }).exec();
  }

  /**
   * Takes back whatever commission an order still carries (order deleted, or
   * an approval undone). Appends a negative COMMISSION entry instead of
   * deleting rows: the commission may already have been paid out, and the
   * ledger has to keep showing that it was earned and then reversed.
   * Idempotent — an order already netted to zero gets nothing more.
   */
  async reverseByOrder(orderId: string, reason = 'Reversal'): Promise<void> {
    if (!isValidObjectId(orderId)) return;
    const rows = await this.transactionModel
      .aggregate([
        {
          $match: {
            orderId: toObjectId(orderId),
            type: TransactionType.COMMISSION,
          },
        },
        { $group: { _id: '$coachId', net: { $sum: '$amount' } } },
      ])
      .exec();
    for (const row of rows) {
      if (!(row.net > 0)) continue;
      await this.create({
        coachId: row._id,
        type: TransactionType.COMMISSION,
        amount: -row.net,
        orderId,
        description: `${reason} — Order #${String(orderId).slice(-6)}`,
      });
    }
  }

  async getBalance(coachId: string): Promise<number> {
    if (!isValidObjectId(coachId)) return 0;
    const [row] = await this.transactionModel
      .aggregate([
        { $match: { coachId: toObjectId(coachId) } },
        { $group: { _id: null, balance: { $sum: SIGNED_AMOUNT } } },
      ])
      .exec();
    return row?.balance ?? 0;
  }

  /** Balances for many tribes in one aggregation (tribe id → balance). */
  async getBalances(coachIds: any[]): Promise<Map<string, number>> {
    const ids = coachIds.filter((id) => isValidObjectId(id)).map(toObjectId);
    const balances = new Map<string, number>();
    if (!ids.length) return balances;
    const rows = await this.transactionModel
      .aggregate([
        { $match: { coachId: { $in: ids } } },
        { $group: { _id: '$coachId', balance: { $sum: SIGNED_AMOUNT } } },
      ])
      .exec();
    for (const row of rows) balances.set(String(row._id), row.balance);
    return balances;
  }
}
