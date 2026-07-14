import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CoachKit } from '../../schemas/coach-kit.schema';

@Injectable()
export class CoachKitsService {
  constructor(
    @InjectModel(CoachKit.name) private kitModel: Model<CoachKit>,
  ) {}

  create(data: any) {
    return this.kitModel.create(data);
  }

  // List a coach's kits with each product populated and the buildable inventory
  // computed live = min over items of floor(stockLevel / quantityPerKit).
  async findByCoach(coachId: string) {
    const kits = await this.kitModel
      .find({ coachId, isDeleted: { $ne: true } } as any)
      .populate({
        path: 'items.productId',
        select: 'name stockLevel imageUrl sku retailPrice baseProductionCost isDeleted',
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return kits.map((k: any) => ({ ...k, availableKits: this.buildable(k) }));
  }

  private buildable(kit: any): number {
    const items = (kit.items || []).filter((i: any) => i.productId);
    if (!items.length) return 0;
    let min = Infinity;
    for (const it of items) {
      const stock = it.productId?.stockLevel ?? 0;
      const per = it.quantity || 1;
      min = Math.min(min, Math.floor(stock / per));
    }
    return min === Infinity ? 0 : Math.max(0, min);
  }

  async update(id: string, data: any) {
    const doc = await this.kitModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('Kit not found');
    return doc;
  }

  async remove(id: string) {
    const doc = await this.kitModel
      .findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('Kit not found');
    return doc;
  }
}
