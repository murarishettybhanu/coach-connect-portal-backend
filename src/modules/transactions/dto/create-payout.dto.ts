import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreatePayoutDto {
  @IsMongoId()
  coachId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  utrReference?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
