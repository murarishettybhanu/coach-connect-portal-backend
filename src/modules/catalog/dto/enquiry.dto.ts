import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { EnquiryStatus } from '../../../schemas/enquiry.schema';
import { TitleCaseName } from '../../../common/decorators/title-case-name.decorator';

// Public form — every field is capped so an anonymous caller can't park
// megabytes of text in the admin inbox.
export class CreateEnquiryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @TitleCaseName()
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  interest?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  timeline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;
}

export class UpdateEnquiryDto {
  @IsOptional()
  @IsEnum(EnquiryStatus)
  status?: EnquiryStatus;
}
