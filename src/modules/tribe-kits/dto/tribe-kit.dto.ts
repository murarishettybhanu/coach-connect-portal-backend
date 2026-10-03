import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const MAX_KIT_ITEMS = 100;
export const MAX_KIT_ITEM_QUANTITY = 100;

export class TribeKitItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_KIT_ITEM_QUANTITY)
  quantity: number;
}

class TribeKitFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // INR, 2 dp at most. null (or omitted on create) = Σ retail × qty. The
  // production-cost floor is checked in the service, which knows the products.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  kitPrice?: number | null;
}

export class CreateTribeKitDto extends TribeKitFieldsDto {
  @IsMongoId()
  coachId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KIT_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TribeKitItemDto)
  items: TribeKitItemDto[];
}

export class UpdateTribeKitDto extends TribeKitFieldsDto {
  // Accepted because the kit form sends it on every save; a kit can't move to
  // another tribe, so a different value is refused in the service.
  @IsOptional()
  @IsMongoId()
  coachId?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KIT_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TribeKitItemDto)
  items?: TribeKitItemDto[];
}
