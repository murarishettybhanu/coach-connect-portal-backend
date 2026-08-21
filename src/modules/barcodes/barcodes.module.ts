import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Barcode, BarcodeSchema } from '../../schemas/barcode.schema';
import { BarcodesService } from './barcodes.service';
import { BarcodesController } from './barcodes.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Barcode.name, schema: BarcodeSchema }]),
  ],
  controllers: [BarcodesController],
  providers: [BarcodesService],
  exports: [BarcodesService],
})
export class BarcodesModule {}
