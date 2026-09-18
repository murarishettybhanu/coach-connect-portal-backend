import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestOtpDto {
  // Loose on purpose — the service normalises "+91 98765 43210" and friends,
  // and rejects anything that can't be a number.
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phone: string;
}

export class VerifyOtpDto {
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phone: string;

  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code: string;
}
