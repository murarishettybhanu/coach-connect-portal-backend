import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign } from '../../schemas/campaign.schema';
import { Product } from '../../schemas/product.schema';
import {
  CampaignProductDto,
  CreateCampaignDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

// Campaign fields a create/update may write, besides coachId and products
// (handled explicitly). `claims` is never client-writable.
const WRITABLE_FIELDS = [
  'name',
  'type',
  'slug',
  'status',
  'formType',
  'deliveryType',
  'description',
  'successMessage',
  'length',
  'breadth',
  'height',
  'packageWeight',
] as const;

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    // Read-only: checks a campaign's products belong to its tribe.
    @InjectModel(Product.name) private productModel: Model<Product>,
  ) { }

  /**
   * A campaign may only offer its own tribe's (live) products — anything else
   * would let a tribe sell, or ship kits from, another tribe's inventory.
   */
  async assertProductsBelongTo(
    products: { productId: any }[],
    coachId: string,
  ): Promise<void> {
    const ids = [...new Set(products.map((p) => String(p.productId)))];
    if (!ids.length) return;
    const owned = await this.productModel
      .countDocuments({ _id: { $in: ids }, coachId, isDeleted: { $ne: true } } as any)
      .exec();
    if (owned !== ids.length) {
      throw new BadRequestException(
        'Every campaign product must be one of this tribe’s own products',
      );
    }
  }

  // Explicit field-by-field build: the body is never handed to Mongo as-is,
  // so operators like `$set` in a payload have nowhere to go.
  private pick(dto: CreateCampaignDto | UpdateCampaignDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of WRITABLE_FIELDS) {
      const value = (dto as any)[key];
      if (value !== undefined) out[key] = value;
    }
    if (dto.products) {
      out.products = dto.products.map((p: CampaignProductDto) => ({
        productId: p.productId,
        retailPrice: p.retailPrice ?? 0,
      }));
    }
    return out;
  }

  // Only populate products that are not soft-deleted, so deleted products drop
  // out of storefront/campaign listings. Order history uses a separate populate
  // path and is unaffected — old orders still resolve deleted products.
  private readonly activeProductPopulate = {
    path: 'products.productId',
    match: { isDeleted: { $ne: true } },
    // Never expose internal cost or stock on campaign responses (many are public;
    // stock can be negative, and shortfalls are for the admin only).
    select: '-baseProductionCost -stockLevel -sizeStock',
  };

  // A populate `match` sets non-matching refs to null rather than removing the
  // array entry, so strip those out to leave only live products.
  private stripDeletedProducts<T>(result: T): T {
    const strip = (campaign: any) => {
      if (campaign?.products) {
        campaign.products = campaign.products.filter((p: any) => p.productId != null);
      }
    };
    if (Array.isArray(result)) result.forEach(strip);
    else strip(result);
    return result;
  }

  // `coachId` is resolved by the controller (a tribe's own id, or the admin's choice).
  async create(dto: CreateCampaignDto, coachId: string): Promise<Campaign> {
    await this.assertProductsBelongTo(dto.products, coachId);
    const campaign = new this.campaignModel({ ...this.pick(dto), coachId });
    return campaign.save();
  }

  async findAll(): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find()
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    return this.stripDeletedProducts(campaigns) as unknown as Campaign[];
  }

  async findByCoach(coachId: string): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find({ coachId } as any)
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    return this.stripDeletedProducts(campaigns) as unknown as Campaign[];
  }

  async findBySlug(slug: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findOne({ slug } as any)
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with slug ${slug} not found`);
    }
    return this.stripDeletedProducts(campaign) as unknown as Campaign;
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findById(id)
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return this.stripDeletedProducts(campaign) as unknown as Campaign;
  }

  /**
   * `coachId` is the campaign's owner after this update — the current owner,
   * or a new one when an admin reassigns it.
   */
  async update(
    id: string,
    dto: UpdateCampaignDto,
    coachId: string,
  ): Promise<Campaign> {
    const existing = await this.campaignModel.findById(id).select('coachId products').lean().exec();
    if (!existing) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    const reassigned = String(existing.coachId) !== String(coachId);
    // New products, or the existing ones when the owner changes, must belong
    // to the owner the campaign ends up with.
    const products = dto.products ?? (reassigned ? existing.products || [] : []);
    await this.assertProductsBelongTo(products, coachId);

    const $set = { ...this.pick(dto), ...(reassigned ? { coachId } : {}) };
    const updatedCampaign = await this.campaignModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .exec();
    if (!updatedCampaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return updatedCampaign;
  }
}
