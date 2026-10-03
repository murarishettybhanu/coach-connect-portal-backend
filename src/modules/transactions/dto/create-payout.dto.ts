import { IsMongoId, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePayoutDto {
  @IsMongoId()
  coachId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  // Unique across payouts — the same bank transfer can't be recorded twice.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  utrReference?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
