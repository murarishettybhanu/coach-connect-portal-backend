import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  RestockItemKind,
  RestockStatus,
} from '../../../schemas/restock-request.schema';

export const MAX_RESTOCK_ITEMS = 100;
export const MAX_RESTOCK_QUANTITY = 100_000;
export const MAX_RESTOCK_NOTE = 1000;

export class RestockItemDto {
  @IsEnum(RestockItemKind)
  kind: RestockItemKind;

  // A Product id (kind PRODUCT) or TribeKit id (kind KIT) of the caller's tribe.
  @IsMongoId()
  id: string;

  @IsInt()
  @Min(1)
  @Max(MAX_RESTOCK_QUANTITY)
  quantity: number;
}

export class CreateRestockRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RESTOCK_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => RestockItemDto)
  items: RestockItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_RESTOCK_NOTE)
  note?: string;

  @IsOptional()
  @IsISO8601()
  neededBy?: string;
}

export class UpdateRestockRequestDto {
  @IsOptional()
  @IsEnum(RestockStatus)
  status?: RestockStatus;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_RESTOCK_NOTE)
  adminNote?: string;
}
