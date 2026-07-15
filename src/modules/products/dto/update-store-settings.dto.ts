import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

// Tribe-editable store fields only. A coach may change the retail price and
// publish/unpublish their own products — nothing else (e.g. base cost).
export class UpdateStoreSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  retailPrice?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
