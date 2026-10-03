import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequestStatus } from '../../../schemas/quote-request.schema';
import { TitleCaseName } from '../../../common/decorators/title-case-name.decorator';

// Bounds for the public estimation form: a kit is a handful of products, and
// even a large corporate run stays well under these.
const MAX_LINE_ITEMS = 50;
const MAX_LINE_QUANTITY = 100000;

export class LineItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity: number;
}

export class GuestEstimationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @TitleCaseName()
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  mobile: string;

  @IsOptional()
  @IsMongoId()
  kitId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items?: LineItemDto[];
}

export class TribeQuoteDto {
  @IsOptional()
  @IsMongoId()
  kitId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items?: LineItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateRequestDto {
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
