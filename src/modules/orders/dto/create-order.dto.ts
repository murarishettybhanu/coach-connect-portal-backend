import {
  IsBoolean,
  IsArray,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType } from '../../../schemas/order.schema';

// Sanity caps for a public endpoint. A claim is one of each kit product and a
// storefront basket is a handful of lines; nothing legitimate comes near these.
export const MAX_ORDER_ITEMS = 50;
export const MAX_ITEM_QUANTITY = 100;

// Address block for ORDER CREATE. Only contact (fullName + phone) is mandatory here,
// because "without address" campaign claims omit the address entirely (it's attached
// later). Full-address completeness for "with address" campaigns is enforced in
// orders.service.create() based on the campaign's formType.
export class ShippingAddressDto {
  @IsNotEmpty()
  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  addressLine1?: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  landmark?: string;

  @IsOptional()
  @IsString()
  sectorVillage?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  // Optional second number for the courier.
  @IsOptional()
  @IsString()
  alternatePhone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class OrderItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_ITEM_QUANTITY)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  retailPrice?: number;

  // Optional per-item customization captured from the customer (TEXT/PHOTO/SIZE).
  @IsOptional()
  @IsString()
  customizationType?: string;

  // For PHOTO this is the uploaded image's URL, which must be in our own
  // bucket — checked in OrdersService.create.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  customizationValue?: string;
}

export class CreateOrderDto {
  @IsMongoId()
  coachId: string;

  @IsOptional()
  @IsMongoId()
  campaignId?: string;

  @IsEnum(OrderType)
  type: OrderType;

  // Accepted but recomputed server-side; whitelisted so the request isn't rejected.
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress: ShippingAddressDto;

  // Proof that the phone number was verified over WhatsApp. Required for
  // campaign claims submitted by the public forms; see OrdersService.create.
  @IsOptional()
  @IsString()
  otpToken?: string;

  // The customer ticked the delivery-details agreement on the form.
  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
