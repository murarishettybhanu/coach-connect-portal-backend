import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../../users/users.service';
import { OTP_PROOF_AUDIENCE } from '../token-claims';

describe('JwtStrategy', () => {
  const user = { _id: '64b000000000000000000001', tokenVersion: 2 };
  let findOneById: jest.Mock;
  let strategy: JwtStrategy;

  beforeEach(() => {
    findOneById = jest.fn().mockResolvedValue(user);
    strategy = new JwtStrategy(
      { get: () => 'test-secret' } as unknown as ConfigService,
      { findOneById } as unknown as UsersService,
    );
  });

  it('accepts a login token at the current token version', async () => {
    await expect(strategy.validate({ sub: user._id, tv: 2 })).resolves.toBe(
      user,
    );
  });

  it('rejects a token from before the last password change', async () => {
    await expect(
      strategy.validate({ sub: user._id, tv: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('treats a pre-versioning token as version 0', async () => {
    findOneById.mockResolvedValueOnce({ ...user, tokenVersion: 0 });
    await expect(strategy.validate({ sub: user._id })).resolves.toBeDefined();

    // …and a user with no version field as 0 too.
    findOneById.mockResolvedValueOnce({ _id: user._id });
    await expect(strategy.validate({ sub: user._id })).resolves.toBeDefined();
  });

  it('rejects an OTP proof token, which shares the signing secret', async () => {
    // Exactly what WhatsappOtpService issues.
    const proof = new JwtService({ secret: 'test-secret' }).sign(
      { sub: '919876543210', purpose: 'whatsapp-otp' },
      { audience: OTP_PROOF_AUDIENCE },
    );
    const payload = new JwtService({ secret: 'test-secret' }).decode(proof);

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Rejected on its claims alone — never looked up as a user.
    expect(findOneById).not.toHaveBeenCalled();
  });

  it('rejects any token carrying a purpose, audience or not', async () => {
    await expect(
      strategy.validate({ sub: user._id, tv: 2, purpose: 'whatsapp-otp' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token for a user that no longer exists', async () => {
    findOneById.mockResolvedValueOnce(null);
    await expect(
      strategy.validate({ sub: user._id, tv: 2 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
