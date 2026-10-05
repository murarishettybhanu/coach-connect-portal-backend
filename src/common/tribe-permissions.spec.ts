import 'reflect-metadata';
import { resolvePermissions, TRIBE_PERMISSIONS } from './tribe-permissions';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTribePermissionsDto } from '../modules/tribes/dto/update-tribe.dto';

describe('tribe permissions', () => {
  const DEFAULTS = { members: false, campaigns: true, storefront: true };

  it('Tribe Members is off by default; campaigns and storefront are on', () => {
    expect(resolvePermissions(undefined)).toEqual(DEFAULTS);
    expect(resolvePermissions(null)).toEqual(DEFAULTS);
    expect(resolvePermissions({})).toEqual(DEFAULTS);
  });

  it('uses stored booleans and ignores junk / unknown keys', () => {
    expect(resolvePermissions({ members: true, storefront: false })).toEqual({
      ...DEFAULTS,
      members: true,
      storefront: false,
    });
    expect(resolvePermissions({ members: 'yes', other: true })).toEqual(
      DEFAULTS,
    );
  });

  it('every registered permission is settable through the DTO', async () => {
    for (const p of TRIBE_PERMISSIONS) {
      const dto = plainToInstance(UpdateTribePermissionsDto, { [p.key]: true });
      expect(
        await validate(dto as object, {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).toEqual([]);
    }
  });

  it('the DTO rejects non-booleans and unknown permissions', async () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    expect(
      (
        await validate(
          plainToInstance(UpdateTribePermissionsDto, {
            members: 'yes',
          }) as object,
          opts,
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(UpdateTribePermissionsDto, { admin: true }) as object,
          opts,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
