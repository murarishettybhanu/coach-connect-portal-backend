import { UserRole } from '../../../schemas/user.schema';
export declare class RegisterDto {
    email: string;
    password: string;
    name: string;
    role?: UserRole;
    phoneNumber?: string;
}
