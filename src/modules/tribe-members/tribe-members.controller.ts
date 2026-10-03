import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { TribeMembersService } from './tribe-members.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { userIdOf } from '../../common/utils/ownership';
import { UserRole } from '../../schemas/user.schema';

// Read only. Admins see every tribe's members; a TRIBE user only ever sees its
// own — the tribe is taken from the session, never from the query, and another
// tribe's member reads as "not found".
@Controller('tribe-members')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.TRIBE)
export class TribeMembersController {
  constructor(private readonly membersService: TribeMembersService) {}

  /** undefined for an admin; the caller's own tribe id for a TRIBE user. */
  private async scopeOf(req: any): Promise<string | undefined> {
    if (req.user?.role === UserRole.ADMIN) return undefined;
    return this.membersService.tribeIdForUser(userIdOf(req.user));
  }

  // ?coachId=<id or comma-separated ids>&search=&page=&limit=
  // (coachId is ignored for a TRIBE user — always their own tribe)
  @Get()
  async findAll(
    @Request() req: any,
    @Query('coachId') coachId?: string | string[],
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const own = await this.scopeOf(req);
    return this.membersService.findAll({
      coachId: own ?? coachId,
      search,
      page,
      limit,
    });
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.membersService.findOne(id, await this.scopeOf(req));
  }

  @Get(':id/orders')
  async findOrders(@Request() req: any, @Param('id') id: string) {
    return this.membersService.findOrders(id, await this.scopeOf(req));
  }
}
