import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { isLoginTokenPayload, type LoginTokenPayload } from '../token-claims';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    // Fail fast: never fall back to a well-known secret (would allow token forgery).
    if (!secret) {
      throw new Error('JWT_SECRET environment variable must be set');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: LoginTokenPayload) {
    // OTP proofs share the signing secret; their `sub` is a phone number, not
    // a user, and they must never pass as a session.
    if (!isLoginTokenPayload(payload)) {
      throw new UnauthorizedException();
    }
    const user = await this.usersService.findOneById(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    // A password change bumps the version, which retires every older token.
    // Tokens from before versioning carry none and count as version 0.
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedException('Session expired — please sign in again');
    }
    return user;
  }
}
