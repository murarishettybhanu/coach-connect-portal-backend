import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CampaignFormType,
  CampaignStatus,
  CampaignType,
} from '../../../schemas/campaign.schema';
import { BarcodeType } from '../../../schemas/barcode.schema';

export class CampaignProductDto {
  @IsMongoId()
  productId: string;

  // Store sales only; welcome kits send 0.
  @IsOptional()
  @IsNumber()
  @Min(0)
  retailPrice?: number;
}

/**
 * Fields shared by create and update. Everything a campaign form sends, and
 * nothing else — `claims` and ownership are server-managed.
 */
class CampaignFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(CampaignFormType)
  formType?: CampaignFormType;

  // null clears it (the type is then chosen at dispatch).
  @IsOptional()
  @IsEnum(BarcodeType)
  deliveryType?: BarcodeType | null;

  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @IsOptional() @IsNumber() @Min(0) length?: number;
  @IsOptional() @IsNumber() @Min(0) breadth?: number;
  @IsOptional() @IsNumber() @Min(0) height?: number;
  @IsOptional() @IsNumber() @Min(0) packageWeight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  successMessage?: string;
}

export class CreateCampaignDto extends CampaignFieldsDto {
  // Required for admins. A TRIBE caller's value is ignored — the campaign is
  // always created under the caller's own tribe.
  @IsOptional()
  @IsMongoId()
  coachId?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  name: string;

  @IsEnum(CampaignType)
  type: CampaignType;

  // Public URL segment.
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  slug: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products: CampaignProductDto[];
}

export class UpdateCampaignDto extends CampaignFieldsDto {
  // Admin may reassign; ignored for TRIBE callers.
  @IsOptional()
  @IsMongoId()
  coachId?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(CampaignType)
  type?: CampaignType;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products?: CampaignProductDto[];
}
