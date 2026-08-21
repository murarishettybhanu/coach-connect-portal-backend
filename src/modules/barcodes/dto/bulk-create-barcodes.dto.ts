import { ArrayNotEmpty, IsArray, IsEnum, IsString } from 'class-validator';
import { BarcodeType } from '../../../schemas/barcode.schema';

export class BulkCreateBarcodesDto {
  @IsEnum(BarcodeType)
  type: BarcodeType;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes: string[];
}
