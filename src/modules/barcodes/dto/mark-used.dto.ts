import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkBarcodeUsedDto {
  // Why it was written off — damaged label, used outside the system. Optional,
  // but the reason is the only thing that explains a missing barcode later.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
