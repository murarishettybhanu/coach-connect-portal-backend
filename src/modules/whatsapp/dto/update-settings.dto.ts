import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateWhatsappSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  acknowledgementText?: string;

  @IsOptional()
  @IsBoolean()
  businessHoursEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  afterHoursText?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'openTime must be HH:mm' })
  openTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'closeTime must be HH:mm' })
  closeTime?: string;

  // 0 = Sunday … 6 = Saturday.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  openDays?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
