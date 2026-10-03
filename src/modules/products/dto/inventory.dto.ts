import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class AddInventoryDto {
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  reason?: string;

  // Sized products: which size the stock goes to. Omitted = Unassigned.
  @IsOptional()
  @IsString()
  size?: string;
}

export class RemoveInventoryDto {
  @IsInt()
  @Min(1)
  quantity: number;

  // A reason is mandatory when removing stock (damage, correction, loss…).
  @IsString()
  @IsNotEmpty()
  reason: string;

  // Sized products: which size the stock comes from. Omitted = Unassigned.
  @IsOptional()
  @IsString()
  size?: string;
}

class SizeQtyDto {
  @IsString()
  @IsNotEmpty()
  size: string;

  // Whole units; may be negative (a shortfall the admin chooses to keep).
  @IsInt()
  qty: number;
}

// The admin's per-size counts for one product (split and/or correction).
export class SetSizeStockDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SizeQtyDto)
  sizes: SizeQtyDto[];

  @IsInt()
  unassigned: number;

  @IsOptional()
  @IsString()
  reason?: string;

  // The product's updatedAt when the admin loaded it — rejects stale saves.
  @IsDateString()
  expectedUpdatedAt: string;
}
