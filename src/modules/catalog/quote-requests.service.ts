import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  QuoteRequest,
  RequestSource,
} from '../../schemas/quote-request.schema';
import { CatalogService } from './catalog.service';

@Injectable()
export class QuoteRequestsService {
  constructor(
    @InjectModel(QuoteRequest.name)
    private requestModel: Model<QuoteRequest>,
    private catalogService: CatalogService,
  ) {}

  // Build priced line items from either a kit or an explicit item list.
  private async resolveLines(input: {
    kitId?: string;
    items?: { productId: string; quantity: number }[];
  }) {
    let raw = input.items || [];
    let kitName: string | undefined;
    let kitId: string | undefined;
    if (input.kitId) {
      const kit = await this.catalogService.findKit(input.kitId);
      if (kit) {
        kitId = kit._id.toString();
        kitName = kit.name;
        // A kit selection expands to its items (merged with any extra items).
        raw = [
          ...kit.items.map((i) => ({
            productId: i.productId.toString(),
            quantity: i.quantity,
          })),
          ...raw,
        ];
      }
    }
    if (!raw.length) {
      throw new BadRequestException('Add at least one product to your kit.');
    }
    const { items, total } = await this.catalogService.priceItems(raw);
    if (!items.length) {
      throw new BadRequestException('None of the selected products are available.');
    }
    return { items, total, kitId, kitName };
  }

  async createGuestEstimation(input: {
    name: string;
    mobile: string;
    kitId?: string;
    items?: { productId: string; quantity: number }[];
  }) {
    const { items, total, kitId, kitName } = await this.resolveLines(input);
    return this.requestModel.create({
      source: RequestSource.GUEST,
      name: input.name,
      mobile: input.mobile,
      kitId,
      kitName,
      items,
      estimatedTotal: total,
    } as any);
  }

  async createCoachQuote(
    coach: { _id: any; name?: string; brand?: string },
    input: {
      kitId?: string;
      items?: { productId: string; quantity: number }[];
      note?: string;
    },
  ) {
    const { items, total, kitId, kitName } = await this.resolveLines(input);
    return this.requestModel.create({
      source: RequestSource.COACH,
      coachId: coach._id,
      coachName: coach.name || coach.brand,
      kitId,
      kitName,
      items,
      estimatedTotal: total,
      note: input.note,
    } as any);
  }

  list(source?: RequestSource) {
    const filter: any = {};
    if (source) filter.source = source;
    return this.requestModel
      .find(filter)
      .populate('coachId', 'name brand username')
      .sort({ createdAt: -1 })
      .exec();
  }

  update(id: string, data: { status?: string; note?: string }) {
    return this.requestModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
  }
}
