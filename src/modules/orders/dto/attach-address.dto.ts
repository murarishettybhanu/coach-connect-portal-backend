import {
  IsEmail,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// A COMPLETE delivery address — used when attaching an address to an existing
// "without address" claim (step-2 page or bulk upload). Unlike the create-time
// ShippingAddressDto, the postal fields are all required here.
export class FullAddressDto {
  @IsNotEmpty()
  @IsString()
  fullName: string;

  @IsNotEmpty()
  @IsString()
  addressLine1: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  landmark?: string;

  @IsOptional()
  @IsString()
  sectorVillage?: string;

  @IsNotEmpty()
  @IsString()
  city: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsNotEmpty()
  @IsString()
  state: string;

  @IsNotEmpty()
  @IsString()
  pincode: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

// Public: customer (or bulk upload) attaches an address to their address-pending
// claim(s), matched by campaign + phone.
export class AttachAddressDto {
  @IsMongoId()
  campaignId: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  @ValidateNested()
  @Type(() => FullAddressDto)
  address: FullAddressDto;
}

// Tribe/Admin bulk PATCH of a specific claim's address. The claim already carries
// fullName/phone from step 1, so contact fields are optional here (merged, not
// overwritten); only the postal fields are required.
export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsNotEmpty()
  @IsString()
  addressLine1: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  landmark?: string;

  @IsOptional()
  @IsString()
  sectorVillage?: string;

  @IsNotEmpty()
  @IsString()
  city: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsNotEmpty()
  @IsString()
  state: string;

  @IsNotEmpty()
  @IsString()
  pincode: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
