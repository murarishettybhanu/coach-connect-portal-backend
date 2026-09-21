import { IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateAddressDto } from './attach-address.dto';

export class ReorderDto {
  /**
   * Corrected address for the replacement parcel. The returned order keeps the
   * address it was actually sent to — that's the record of what went wrong.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAddressDto)
  address?: UpdateAddressDto;
}
