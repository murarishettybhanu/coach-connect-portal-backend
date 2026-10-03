import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { User } from '../../schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string; access_token: string }> {
    const user = await this.usersService.findOneById(userId);
    if (!user || !user.password) {
      throw new UnauthorizedException('User not found');
    }
    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    // Bumps tokenVersion, which signs out every existing session — including
    // this one, so hand back a fresh token for the caller to carry on with.
    await this.usersService.updatePassword(userId, hashed);
    const updated = await this.usersService.findOneById(userId);
    return {
      message: 'Password updated successfully',
      access_token: this.signFor(updated ?? user),
    };
  }

  async login(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findOneByEmail(email);
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(pass, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      access_token: this.signFor(user),
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /** A login token, stamped with the user's current tokenVersion. */
  private signFor(user: User): string {
    return this.jwtService.sign({
      email: user.email,
      sub: String(user._id),
      role: user.role,
      tv: user.tokenVersion ?? 0,
    });
  }
}
