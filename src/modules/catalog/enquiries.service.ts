import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Enquiry, EnquiryStatus } from '../../schemas/enquiry.schema';

// Unread = still NEW and never opened by an admin.
const UNREAD = {
  status: EnquiryStatus.NEW,
  seenAt: { $exists: false },
} as const;

// How many of the newest unread enquiries the portal gets to announce.
const UNREAD_PREVIEW = 5;

@Injectable()
export class EnquiriesService {
  constructor(
    @InjectModel(Enquiry.name) private enquiryModel: Model<Enquiry>,
  ) {}

  create(data: any) {
    return this.enquiryModel.create(data);
  }

  list() {
    return this.enquiryModel.find().sort({ createdAt: -1 }).exec();
  }

  /** The portal's badge and pop-ups: unread count + the newest few. */
  async unread() {
    const [count, latest] = await Promise.all([
      this.enquiryModel.countDocuments(UNREAD as any).exec(),
      this.enquiryModel
        .find(UNREAD as any)
        .sort({ createdAt: -1 })
        .limit(UNREAD_PREVIEW)
        .select('name company interest createdAt')
        .lean()
        .exec(),
    ]);
    return { count, latest };
  }

  /** Opening an enquiry marks it read; the first open's time is kept. */
  async markSeen(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Enquiry not found');
    const updated = await this.enquiryModel
      .findOneAndUpdate(
        { _id: id, seenAt: { $exists: false } } as any,
        { $set: { seenAt: new Date() } },
        { new: true },
      )
      .exec();
    if (updated) return updated;
    const existing = await this.enquiryModel.findById(id).exec();
    if (!existing) throw new NotFoundException('Enquiry not found');
    return existing;
  }

  /** Status change; handling an enquiry (any status) also counts as opening it. */
  async update(id: string, data: { status?: string }) {
    if (!isValidObjectId(id)) throw new NotFoundException('Enquiry not found');
    const existing = await this.enquiryModel.findById(id).exec();
    if (!existing) throw new NotFoundException('Enquiry not found');
    const $set: Record<string, unknown> = {};
    if (data.status) $set.status = data.status;
    if (!existing.seenAt) $set.seenAt = new Date();
    return this.enquiryModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .exec();
  }
}
