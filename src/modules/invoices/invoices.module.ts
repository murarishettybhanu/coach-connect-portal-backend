import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TribeInvoice,
  TribeInvoiceSchema,
} from '../../schemas/tribe-invoice.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { UploadsModule } from '../uploads/uploads.module';
import { InvoicesService } from './invoices.service';
import {
  AdminInvoicesController,
  InvoicesController,
} from './invoices.controller';

// Tribe invoices: admin-uploaded PDFs, stored privately in S3 through
// UploadsService and streamed back only to the admin or the owning tribe.
@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: TribeInvoice.name, schema: TribeInvoiceSchema },
      { name: Tribe.name, schema: TribeSchema },
    ]),
  ],
  providers: [InvoicesService],
  controllers: [AdminInvoicesController, InvoicesController],
})
export class InvoicesModule {}
