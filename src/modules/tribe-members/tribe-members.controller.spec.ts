import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { TribeMembersController } from './tribe-members.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserRole } from '../../schemas/user.schema';

const admin = { user: { _id: 'admin1', role: UserRole.ADMIN } };
const tribeUser = { user: { _id: 'user1', role: UserRole.TRIBE } };

function setup() {
  const service = {
    tribeIdForUser: jest.fn().mockResolvedValue('ownTribe'),
    findAll: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue({}),
    findOrders: jest.fn().mockResolvedValue([]),
  };
  return { service, controller: new TribeMembersController(service as any) };
}

describe('TribeMembersController', () => {
  it('is behind JWT + roles guards, open to admins and tribes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TribeMembersController)).toEqual([
      UserRole.ADMIN,
      UserRole.TRIBE,
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TribeMembersController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it.each([
    [UserRole.ADMIN, true],
    [UserRole.TRIBE, true],
    [UserRole.CUSTOMER, false],
  ])('the roles guard lets a %s through: %s', (role, allowed) => {
    // The real reflector, so this reads the controller's own metadata.
    const guard = new RolesGuard(new Reflector());
    const ctx: any = {
      getHandler: () => TribeMembersController.prototype.findAll,
      getClass: () => TribeMembersController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    };
    expect(guard.canActivate(ctx)).toBe(allowed);
  });

  it('passes an admin list query through, tribe filter included', async () => {
    const { service, controller } = setup();
    await controller.findAll(admin, 'a,b', 'ravi', '2', '50');
    expect(service.tribeIdForUser).not.toHaveBeenCalled();
    expect(service.findAll).toHaveBeenCalledWith({
      coachId: 'a,b',
      search: 'ravi',
      page: '2',
      limit: '50',
    });
  });

  it("forces a tribe's list to its own tribe, whatever coachId it sends", async () => {
    const { service, controller } = setup();
    await controller.findAll(tribeUser, 'someOtherTribe', 'ravi', '1', '20');
    expect(service.tribeIdForUser).toHaveBeenCalledWith('user1');
    expect(service.findAll).toHaveBeenCalledWith({
      coachId: 'ownTribe',
      search: 'ravi',
      page: '1',
      limit: '20',
    });
  });

  it("scopes a tribe's member and order reads to its own tribe; admins unscoped", async () => {
    const { service, controller } = setup();
    await controller.findOne(tribeUser, 'm1');
    await controller.findOrders(tribeUser, 'm1');
    expect(service.findOne).toHaveBeenCalledWith('m1', 'ownTribe');
    expect(service.findOrders).toHaveBeenCalledWith('m1', 'ownTribe');
    await controller.findOne(admin, 'm2');
    await controller.findOrders(admin, 'm2');
    expect(service.findOne).toHaveBeenCalledWith('m2', undefined);
    expect(service.findOrders).toHaveBeenCalledWith('m2', undefined);
  });
});
