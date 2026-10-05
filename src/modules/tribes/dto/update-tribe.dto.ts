import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  HEX_COLOR,
  STOREFRONT_BUTTON_STYLES,
  STOREFRONT_FONTS,
  STOREFRONT_RADII,
} from '../../../common/storefront-theme';

export class SocialLinksDto {
  @IsOptional() @IsString() @MaxLength(500) instagram?: string;
  @IsOptional() @IsString() @MaxLength(500) twitter?: string;
  @IsOptional() @IsString() @MaxLength(500) youtube?: string;
  @IsOptional() @IsString() @MaxLength(500) linkedin?: string;
}

// The wallet page writes holderName/ifsc/upiId; the schema's own names
// (accountHolderName/ifscCode/bankName) are accepted too so older records
// round-trip unchanged.
export class BankingDetailsDto {
  @IsOptional() @IsString() @MaxLength(120) holderName?: string;
  @IsOptional() @IsString() @MaxLength(120) accountHolderName?: string;
  @IsOptional() @IsString() @MaxLength(34) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(20) ifsc?: string;
  @IsOptional() @IsString() @MaxLength(20) ifscCode?: string;
  @IsOptional() @IsString() @MaxLength(120) bankName?: string;
  @IsOptional() @IsString() @MaxLength(120) upiId?: string;
}

const HEX_MESSAGE = 'Colours must be a 6-digit hex code like #1B1F3B';

export class StorefrontColorsDto {
  @IsOptional() @Matches(HEX_COLOR, { message: HEX_MESSAGE }) primary?: string;
  @IsOptional() @Matches(HEX_COLOR, { message: HEX_MESSAGE }) accent?: string;
  @IsOptional()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  background?: string;
  @IsOptional() @Matches(HEX_COLOR, { message: HEX_MESSAGE }) surface?: string;
  @IsOptional() @Matches(HEX_COLOR, { message: HEX_MESSAGE }) text?: string;
}

/** The storefront's look: also applied to the tribe's checkout and claim forms. */
export class StorefrontThemeDto {
  // Which ready-made palette it started from (informational, for the editor).
  @IsOptional() @IsString() @MaxLength(40) preset?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StorefrontColorsDto)
  colors?: StorefrontColorsDto;

  @IsOptional() @IsIn(STOREFRONT_FONTS) headingFont?: string;
  @IsOptional() @IsIn(STOREFRONT_FONTS) bodyFont?: string;
  @IsOptional() @IsIn(STOREFRONT_RADII) radius?: string;
  @IsOptional() @IsIn(STOREFRONT_BUTTON_STYLES) buttonStyle?: string;
  // Show bannerImage behind the storefront header.
  @IsOptional() @IsBoolean() showBanner?: boolean;
}

export class StorefrontConfigDto {
  @IsOptional() @IsString() @MaxLength(1000) bannerImage?: string;
  @IsOptional() @IsString() @MaxLength(32) themeColor?: string;
  @IsOptional() @IsString() @MaxLength(253) customDomain?: string;

  // null resets the storefront to the default look.
  @IsOptional()
  @ValidateNested()
  @Type(() => StorefrontThemeDto)
  theme?: StorefrontThemeDto | null;
}

/**
 * PATCH /tribes/:id. Only these fields can be written; the controller decides
 * which of them a TRIBE caller may touch (see TRIBE_EDITABLE).
 */
export class UpdateTribeDto {
  // Login identity — admin only. Mirrored to the linked User.
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() email?: string;
  // Empty string clears it.
  @IsOptional()
  @ValidateIf((o) => o.phoneNumber !== '')
  @Matches(/^[6-9]\d{9}$/, {
    message: 'Phone number must be 10 digits starting with 6-9',
  })
  phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) username?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;

  // Branding / storefront — the tribe edits these itself.
  @IsOptional() @IsString() @MaxLength(120) brand?: string;
  @IsOptional() @IsString() @MaxLength(200) tagline?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @IsOptional() @IsString() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(1000) profileImage?: string;
  @IsOptional() @IsString() @MaxLength(1000) logoUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankingDetailsDto)
  bankingDetails?: BankingDetailsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => StorefrontConfigDto)
  storefrontConfig?: StorefrontConfigDto;
}

/** Fields a TRIBE caller may change on its own record. */
export const TRIBE_EDITABLE: (keyof UpdateTribeDto)[] = [
  'phoneNumber',
  'brand',
  'tagline',
  'bio',
  'contactEmail',
  'profileImage',
  'logoUrl',
  'socialLinks',
  'bankingDetails',
  'storefrontConfig',
];

/**
 * PATCH /tribes/:id/permissions (admin only). One optional boolean per
 * permission in common/tribe-permissions.ts; omitted ones are left as they are.
 */
export class UpdateTribePermissionsDto {
  // "Tribe Members" page in the Tribe Portal.
  @IsOptional() @IsBoolean() members?: boolean;
  // Creating and editing their own campaigns.
  @IsOptional() @IsBoolean() campaigns?: boolean;
  // The public storefront and its checkout.
  @IsOptional() @IsBoolean() storefront?: boolean;
}
