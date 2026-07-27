import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional } from 'class-validator';

// NOTE: `role` is intentionally NOT accepted here — public self-registration
// must never let a caller choose their role (would allow ADMIN escalation).
// New self-registered users get the schema default (CUSTOMER). Tribes/admins
// are provisioned through the admin-guarded flows.
export class RegisterDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;
}
