import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Enquiry } from '../../schemas/enquiry.schema';

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

  update(id: string, data: { status?: string }) {
    return this.enquiryModel.findByIdAndUpdate(id, data, { new: true }).exec();
  }
}
