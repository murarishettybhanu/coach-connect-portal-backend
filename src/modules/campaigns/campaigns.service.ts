import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Campaign, CampaignStatus } from '../../schemas/campaign.schema';
import { Product } from '../../schemas/product.schema';
import { TribeKit } from '../../schemas/tribe-kit.schema';
import {
  assertPriceAtLeast,
  campaignProductsFor,
  kitTotals,
  roundMoney,
} from '../../common/kit-pricing';
import {
  CampaignProductDto,
  CreateCampaignDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

// Campaign fields a create/update may write, besides coachId, products and the
// kit link (handled explicitly). `claims` is never client-writable.
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
    // Read-only: a kit-linked campaign takes its products and price from it.
    @InjectModel(TribeKit.name) private kitModel: Model<TribeKit>,
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
    return out;
  }

  // Product lines from a form, for a campaign that isn't linked to a kit:
  // always one of each per claim.
  private bodyProducts(products: CampaignProductDto[]) {
    return products.map((p) => ({
      productId: p.productId,
      retailPrice: p.retailPrice ?? 0,
      quantity: 1,
    }));
  }

  private refuseKitPriceWithoutKit(dto: CreateCampaignDto | UpdateCampaignDto) {
    if (dto.kitPrice != null) {
      throw new BadRequestException(
        'A kit price can only be set on a campaign linked to a kit',
      );
    }
  }

  /**
   * Loads a kit for a campaign of `coachId`: its product lines (with
   * quantities and current retail prices) and its production-cost floor.
   * Linking needs a live, active kit. An existing link — which the campaign
   * form re-sends on every save — tolerates a kit deactivated since, and a
   * deleted one only while the campaign stays STOPPED.
   */
  private async loadKit(
    kitId: string,
    coachId: string,
    mode: { linking: boolean; running: boolean },
  ) {
    const kit: any = isValidObjectId(kitId)
      ? await this.kitModel.findOne({ _id: kitId, coachId } as any).lean().exec()
      : null;
    if (!kit) {
      throw new BadRequestException('Choose one of this tribe’s own kits');
    }
    const refused = mode.linking
      ? kit.isDeleted || kit.isActive === false
      : kit.isDeleted && mode.running;
    if (refused) {
      throw new BadRequestException(
        'This kit is no longer active. Choose another kit or switch the campaign to products.',
      );
    }
    const items: any[] = kit.items || [];
    const live = await this.productModel
      .find({
        _id: { $in: items.map((i) => i.productId) },
        coachId,
        isDeleted: { $ne: true },
      } as any)
      .select('retailPrice baseProductionCost')
      .lean()
      .exec();
    const byId = new Map(live.map((p: any) => [String(p._id), p]));
    const products = campaignProductsFor(items, byId);
    if (!products.length) {
      throw new BadRequestException('This kit has no products');
    }
    const { minPrice } = kitTotals(
      items.map((i) => ({ quantity: i.quantity, product: byId.get(String(i.productId)) })),
    );
    return { kit, products, minPrice };
  }

  private priceOf(v: number | null | undefined): number | null {
    return v == null ? null : roundMoney(v);
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

  // The linked kit. Public responses read only its name and price; signed-in
  // ones also load its products' production cost, to report the floor a price
  // override must clear — and that cost never leaves this service.
  private readonly publicKitPopulate = { path: 'kitId', select: 'name kitPrice' };
  private readonly internalKitPopulate = {
    path: 'kitId',
    select: 'name kitPrice items',
    populate: { path: 'items.productId', select: 'baseProductionCost isDeleted' },
  };

  /**
   * Shapes campaigns for a response. A populate `match` sets non-matching refs
   * to null rather than removing the array entry, so deleted products are
   * stripped here. Legacy lines get quantity 1, and a linked campaign gets
   * `kitId` as `{ _id, name, kitPrice }` and its `effectivePrice` (plus
   * `kitMinPrice` when `internal` — never on public responses).
   */
  private present<T>(result: T, internal: boolean): T {
    const shape = (campaign: any) => {
      if (!campaign) return;
      campaign.products = (campaign.products || [])
        .filter((p: any) => p.productId != null)
        .map((p: any) => ({ ...p, quantity: p.quantity || 1 }));
      campaign.kitPrice = campaign.kitPrice ?? null;
      const kit = campaign.kitId && typeof campaign.kitId === 'object' && 'name' in campaign.kitId
        ? campaign.kitId
        : null;
      if (!campaign.kitId) {
        campaign.kitId = null;
        campaign.effectivePrice = null;
        return;
      }
      campaign.effectivePrice = campaign.kitPrice ?? kit?.kitPrice ?? null;
      if (kit) {
        if (internal) {
          campaign.kitMinPrice = kitTotals(
            (kit.items || []).map((i: any) => ({
              quantity: i.quantity,
              product: i.productId && !i.productId.isDeleted ? i.productId : null,
            })),
          ).minPrice;
        }
        campaign.kitId = { _id: kit._id, name: kit.name, kitPrice: kit.kitPrice ?? null };
      }
    };
    if (Array.isArray(result)) result.forEach(shape);
    else shape(result);
    return result;
  }

  // `coachId` is resolved by the controller (a tribe's own id, or the admin's choice).
  //
  // With a kitId the products come from the kit (any sent are ignored) and the
  // effective price — the override, else the kit's own — must clear the floor.
  async create(dto: CreateCampaignDto, coachId: string): Promise<Campaign> {
    let link: Record<string, unknown>;
    if (dto.kitId) {
      const { kit, products, minPrice } = await this.loadKit(dto.kitId, coachId, { linking: true, running: true });
      const kitPrice = this.priceOf(dto.kitPrice);
      assertPriceAtLeast(kitPrice ?? kit.kitPrice ?? null, minPrice);
      link = { products, kitId: kit._id, kitPrice };
    } else {
      this.refuseKitPriceWithoutKit(dto);
      const products = dto.products ?? [];
      if (!products.length) {
        throw new BadRequestException('Add at least one product or choose a kit');
      }
      await this.assertProductsBelongTo(products, coachId);
      link = { products: this.bodyProducts(products), kitId: null, kitPrice: null };
    }
    const campaign = new this.campaignModel({ ...this.pick(dto), ...link, coachId });
    const saved = await campaign.save();
    return this.findOne(String(saved._id), { internal: true });
  }

  async findAll(): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find()
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .populate(this.internalKitPopulate)
      .lean()
      .exec();
    return this.present(campaigns, true) as unknown as Campaign[];
  }

  async findByCoach(coachId: string): Promise<Campaign[]> {
    const campaigns = await this.campaignModel
      .find({ coachId } as any)
      .populate(this.activeProductPopulate)
      .populate(this.internalKitPopulate)
      .lean()
      .exec();
    return this.present(campaigns, true) as unknown as Campaign[];
  }

  // Public (the claim form): no production cost, no kitMinPrice.
  async findBySlug(slug: string): Promise<Campaign> {
    const campaign = await this.campaignModel
      .findOne({ slug } as any)
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .populate(this.publicKitPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with slug ${slug} not found`);
    }
    return this.present(campaign, false) as unknown as Campaign;
  }

  // Public shape unless `internal` (GET /campaigns/:id is unauthenticated).
  async findOne(id: string, opts: { internal?: boolean } = {}): Promise<Campaign> {
    const internal = !!opts.internal;
    const campaign = await this.campaignModel
      .findById(id)
      .populate('coachId', 'username brand name logoUrl contactEmail')
      .populate(this.activeProductPopulate)
      .populate(internal ? this.internalKitPopulate : this.publicKitPopulate)
      .lean()
      .exec();
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return this.present(campaign, internal) as unknown as Campaign;
  }

  /**
   * `coachId` is the campaign's owner after this update — the current owner,
   * or a new one when an admin reassigns it.
   *
   * Kit link: `kitId` omitted keeps the current link, a kit id (re)links, null
   * unlinks. While linked the products are the kit's — any sent are ignored —
   * and `kitPrice` is an override (null = follow the kit). The price floor is
   * checked when the link or the price changes, not on every edit, so a
   * campaign can always be paused or stopped.
   */
  async update(
    id: string,
    dto: UpdateCampaignDto,
    coachId: string,
  ): Promise<Campaign> {
    const existing: any = await this.campaignModel
      .findById(id)
      .select('coachId products kitId kitPrice status')
      .lean()
      .exec();
    if (!existing) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    const reassigned = String(existing.coachId) !== String(coachId);
    const wasLinked: string | null = existing.kitId ? String(existing.kitId) : null;
    const target: string | null = dto.kitId === undefined ? wasLinked : dto.kitId;

    const $set: Record<string, unknown> = {
      ...this.pick(dto),
      ...(reassigned ? { coachId } : {}),
    };

    if (target) {
      const relinked = target !== wasLinked;
      const running = (dto.status ?? existing.status) !== CampaignStatus.STOPPED;
      const { kit, products, minPrice } = await this.loadKit(target, coachId, {
        linking: relinked,
        running,
      });
      const kitPrice =
        dto.kitPrice !== undefined
          ? this.priceOf(dto.kitPrice)
          : relinked ? null : (existing.kitPrice ?? null);
      // Only a price that is changing is held to the floor: the form re-sends
      // kitId and kitPrice on every save, and pausing or stopping must not fail
      // because a product's cost rose since.
      if (relinked || kitPrice !== (existing.kitPrice ?? null)) {
        assertPriceAtLeast(kitPrice ?? kit.kitPrice ?? null, minPrice);
      }
      Object.assign($set, { kitId: kit._id, kitPrice, products });
    } else {
      this.refuseKitPriceWithoutKit(dto);
      // New products, or the existing ones when the owner changes, must belong
      // to the owner the campaign ends up with.
      const products = dto.products ?? (reassigned || wasLinked ? existing.products || [] : []);
      await this.assertProductsBelongTo(products, coachId);
      if (dto.products) $set.products = this.bodyProducts(dto.products);
      if (wasLinked) {
        // Unlinked: the lines stay, at one of each, until the form sends others.
        if (!dto.products) {
          $set.products = (existing.products || []).map((p: any) => ({
            productId: p.productId,
            retailPrice: p.retailPrice ?? 0,
            quantity: 1,
          }));
        }
        Object.assign($set, { kitId: null, kitPrice: null });
      }
    }

    const updatedCampaign = await this.campaignModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .exec();
    if (!updatedCampaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return this.findOne(id, { internal: true });
  }
}
