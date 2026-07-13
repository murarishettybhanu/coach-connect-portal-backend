import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class AddInventoryDto {
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class RemoveInventoryDto {
  @IsInt()
  @Min(1)
  quantity: number;

  // A reason is mandatory when removing stock (damage, correction, loss…).
  @IsString()
  @IsNotEmpty()
  reason: string;
}
