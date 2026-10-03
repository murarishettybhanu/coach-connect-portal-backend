import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../../schemas/user.schema';

describe('RolesGuard', () => {
  const contextFor = (user: unknown) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const guardRequiring = (roles?: UserRole[]) =>
    new RolesGuard({
      getAllAndOverride: () => roles,
    } as unknown as Reflector);

  it('allows a user with a required role', () => {
    expect(
      guardRequiring([UserRole.ADMIN]).canActivate(
        contextFor({ role: UserRole.ADMIN }),
      ),
    ).toBe(true);
  });

  it('refuses a user without one', () => {
    expect(
      guardRequiring([UserRole.ADMIN]).canActivate(
        contextFor({ role: UserRole.TRIBE }),
      ),
    ).toBe(false);
  });

  it('refuses (rather than throwing) when no user is on the request', () => {
    expect(
      guardRequiring([UserRole.ADMIN]).canActivate(contextFor(undefined)),
    ).toBe(false);
  });

  it('lets anything through when no roles are required', () => {
    expect(guardRequiring(undefined).canActivate(contextFor(undefined))).toBe(
      true,
    );
  });
});
