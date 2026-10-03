import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
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

  // Accepted so a form can echo a line back, but not used: a campaign that
  // isn't linked to a kit always takes 1 of each product per claim.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;
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

  // Per-campaign override of the linked kit's price (INR, 2 dp at most);
  // null = follow the kit. Refused without a kit; the production-cost floor is
  // checked in the service.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  kitPrice?: number | null;
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

  // Links the campaign to a tribe kit: its products then come from the kit
  // and any `products` sent are ignored.
  @IsOptional()
  @IsMongoId()
  kitId?: string | null;

  // Required unless a kit is linked (then ignored, so not validated either).
  @ValidateIf((o) => !o.kitId)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products?: CampaignProductDto[];
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

  // A kit id links (or re-links) the campaign; null unlinks it, after which
  // products come from the body again. Omitted = unchanged.
  @IsOptional()
  @IsMongoId()
  kitId?: string | null;

  // Ignored while the campaign is linked to a kit (so not validated either).
  @ValidateIf((o) => !o.kitId)
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products?: CampaignProductDto[];
}
