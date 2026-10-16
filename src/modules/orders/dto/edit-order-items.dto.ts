import {
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Admin: add a product to an order (Order details → Add product). */
export class AddOrderItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;

  // The size / text / photo link, when the product is customised.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  customizationValue?: string;
}
