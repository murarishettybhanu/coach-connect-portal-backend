import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TribeKit } from '../../schemas/tribe-kit.schema';
import { Campaign, CampaignStatus } from '../../schemas/campaign.schema';
import { Product } from '../../schemas/product.schema';
import {
  assertPriceAtLeast,
  campaignProductsFor,
  formatInr,
  kitTotals,
  roundMoney,
} from '../../common/kit-pricing';
import {
  CreateTribeKitDto,
  TribeKitItemDto,
  UpdateTribeKitDto,
} from './dto/tribe-kit.dto';

type KitItem = { productId: any; quantity: number };

@Injectable()
export class TribeKitsService {
  constructor(
    @InjectModel(TribeKit.name) private kitModel: Model<TribeKit>,
    // Linked campaigns follow their kit (live sync) and block its removal.
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    // Read-only: ownership, prices and production cost of kit products.
    @InjectModel(Product.name) private productModel: Model<Product>,
  ) {}

  /**
   * Loads a kit's products, refusing any that aren't the tribe's own live
   * products. Returns them by id.
   */
  private async loadOwnedProducts(items: KitItem[], coachId: string) {
    const ids = items.map((i) => String(i.productId));
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Each product can only appear once in a kit',
      );
    }
    const products = await this.productModel
      .find({ _id: { $in: ids }, coachId, isDeleted: { $ne: true } } as any)
      .select('retailPrice baseProductionCost')
      .lean()
      .exec();
    if (products.length !== ids.length) {
      throw new BadRequestException(
        'Every kit product must be one of this tribe’s own products',
      );
    }
    return new Map(products.map((p: any) => [String(p._id), p]));
  }

  private totalsOf(items: KitItem[], byId: Map<string, any>) {
    return kitTotals(
      items.map((i) => ({
        quantity: i.quantity,
        product: byId.get(String(i.productId)),
      })),
    );
  }

  private toItems(items: TribeKitItemDto[]): KitItem[] {
    return items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
  }

  private priceOf(v: number | null | undefined): number | null {
    return v == null ? null : roundMoney(v);
  }

  async create(dto: CreateTribeKitDto) {
    const items = this.toItems(dto.items);
    const byId = await this.loadOwnedProducts(items, dto.coachId);
    const kitPrice = this.priceOf(dto.kitPrice);
    assertPriceAtLeast(kitPrice, this.totalsOf(items, byId).minPrice);

    // Explicit build — the body is never handed to Mongo as-is.
    return this.kitModel.create({
      coachId: dto.coachId as any,
      name: dto.name,
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      items,
      kitPrice,
    });
  }

  // List a coach's kits with each product populated, the buildable inventory
  // computed live = min over items of floor(stockLevel / quantityPerKit), and
  // the pricing references the kit and campaign forms validate against.
  async findByCoach(coachId: string) {
    const kits = await this.kitModel
      .find({ coachId, isDeleted: { $ne: true } } as any)
      .populate({
        path: 'items.productId',
        select:
          'name stockLevel imageUrl sku retailPrice baseProductionCost isDeleted',
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const linked = await this.activeLinkedCounts(kits.map((k: any) => k._id));
    return kits.map((k: any) => {
      const { productValue, minPrice } = kitTotals(
        (k.items || []).map((i: any) => ({
          quantity: i.quantity,
          product: i.productId && !i.productId.isDeleted ? i.productId : null,
        })),
      );
      return {
        ...k,
        kitPrice: k.kitPrice ?? null,
        availableKits: this.buildable(k),
        productValue,
        minPrice,
        linkedCampaigns: linked.get(String(k._id)) ?? 0,
      };
    });
  }

  // Linked campaigns that still count (anything not STOPPED), per kit.
  private async activeLinkedCounts(
    kitIds: any[],
  ): Promise<Map<string, number>> {
    if (!kitIds.length) return new Map();
    const rows = await this.campaignModel
      .aggregate([
        {
          $match: {
            kitId: { $in: kitIds },
            status: { $ne: CampaignStatus.STOPPED },
          },
        },
        { $group: { _id: '$kitId', n: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((r: any) => [String(r._id), r.n]));
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

  /** 409 while any linked campaign is not STOPPED. */
  private async assertNoActiveCampaigns(kitId: string) {
    const active = await this.campaignModel
      .find({ kitId, status: { $ne: CampaignStatus.STOPPED } } as any)
      .select('name')
      .lean()
      .exec();
    if (active.length) {
      throw new ConflictException(
        `This kit is used by active campaigns: ${active.map((c: any) => c.name).join(', ')}. Stop them or switch them to products first.`,
      );
    }
  }

  /**
   * Edits a kit and brings every linked campaign's products in line with it.
   * Everything that can refuse the edit is checked before anything is written.
   * No Mongo transaction (dev runs a standalone mongod): the kit is saved, then
   * campaigns are synced; the sync is idempotent, so re-saving the kit repairs
   * a sync that failed midway.
   */
  async update(id: string, dto: UpdateTribeKitDto) {
    const kit: any = await this.kitModel
      .findOne({ _id: id, isDeleted: { $ne: true } } as any)
      .lean()
      .exec();
    if (!kit) throw new NotFoundException('Kit not found');
    const coachId = String(kit.coachId);
    if (dto.coachId && dto.coachId !== coachId) {
      throw new BadRequestException('A kit can’t be moved to another tribe');
    }

    const items: KitItem[] = dto.items
      ? this.toItems(dto.items)
      : (kit.items || []).map((i: any) => ({
          productId: i.productId,
          quantity: i.quantity || 1,
        }));
    // Products are only re-checked for ownership when the item list is being
    // written; existing items whose product was deleted since simply drop out.
    let byId: Map<string, any>;
    if (dto.items) {
      byId = await this.loadOwnedProducts(items, coachId);
    } else {
      const products = await this.productModel
        .find({
          _id: { $in: items.map((i) => i.productId) },
          isDeleted: { $ne: true },
        } as any)
        .select('retailPrice baseProductionCost')
        .lean()
        .exec();
      byId = new Map(products.map((p: any) => [String(p._id), p]));
    }
    const { minPrice } = this.totalsOf(items, byId);
    const kitPrice =
      dto.kitPrice !== undefined
        ? this.priceOf(dto.kitPrice)
        : (kit.kitPrice ?? null);
    assertPriceAtLeast(kitPrice, minPrice);

    if (dto.isActive === false && kit.isActive !== false) {
      await this.assertNoActiveCampaigns(id);
    }

    // A campaign's own price override must still clear the new floor.
    const tooLow = await this.campaignModel
      .find({ kitId: id, kitPrice: { $ne: null, $lt: minPrice } } as any)
      .select('name')
      .lean()
      .exec();
    if (tooLow.length) {
      throw new ConflictException(
        `These campaigns have a kit price below the new minimum (${formatInr(minPrice)}): ${tooLow
          .map((c: any) => c.name)
          .join(', ')}. Raise their price first.`,
      );
    }

    const $set: Record<string, unknown> = { kitPrice };
    if (dto.items) $set.items = items;
    for (const key of [
      'name',
      'description',
      'imageUrl',
      'isActive',
    ] as const) {
      if (dto[key] !== undefined) $set[key] = dto[key];
    }
    const doc = await this.kitModel
      .findOneAndUpdate(
        { _id: id, isDeleted: { $ne: true } } as any,
        { $set },
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Kit not found');

    // Live sync: linked campaigns carry the kit's current contents.
    await this.campaignModel
      .updateMany({ kitId: id } as any, {
        $set: { products: campaignProductsFor(items, byId) },
      })
      .exec();
    return doc;
  }

  async remove(id: string) {
    const exists = await this.kitModel.exists({ _id: id } as any);
    if (!exists) throw new NotFoundException('Kit not found');
    await this.assertNoActiveCampaigns(id);
    const doc = await this.kitModel
      .findByIdAndUpdate(
        id,
        { isDeleted: true, isActive: false },
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Kit not found');
    return doc;
  }
}
