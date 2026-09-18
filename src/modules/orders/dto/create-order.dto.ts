import {
  IsArray,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType } from '../../../schemas/order.schema';

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

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  retailPrice?: number;

  // Optional per-item customization captured from the customer (TEXT/PHOTO/SIZE).
  @IsOptional()
  @IsString()
  customizationType?: string;

  @IsOptional()
  @IsString()
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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
