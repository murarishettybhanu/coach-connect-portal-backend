import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateEnquiryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  interest?: string;

  @IsOptional()
  @IsString()
  timeline?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class UpdateEnquiryDto {
  @IsOptional()
  @IsString()
  status?: string;
}
