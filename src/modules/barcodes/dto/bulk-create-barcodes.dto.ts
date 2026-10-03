import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { BarcodeType } from '../../../schemas/barcode.schema';

export class BulkCreateBarcodesDto {
  @IsEnum(BarcodeType)
  type: BarcodeType;

  // Codes come from an admin's CSV: trimmed, and spreadsheet quoting
  // ("EN409716859IN") stripped, before checking. The format is kept loose —
  // letters, digits and dashes — rather than the strict 13-character India
  // Post article pattern, since both barcode pools are uploaded through here
  // and the stored data has never been held to that shape.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(5000)
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((c) =>
          typeof c === 'string'
            ? c
                .trim()
                .replace(/^"(.*)"$/, '$1')
                .trim()
            : c,
        )
      : value,
  )
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @Matches(/^[A-Za-z0-9-]+$/, {
    each: true,
    message: 'Barcodes may only contain letters, digits and dashes',
  })
  codes: string[];
}
