import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkReturnedDto {
  // Typed by hand or scanned off the label — either way it's the consignment number.
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  trackingNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
