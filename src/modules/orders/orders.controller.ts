import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { OrderStatus } from '../../schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly tribesService: TribesService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  async findMyOrders(@Request() req) {
    const coach = await this.tribesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
    return this.ordersService.findByCoach(coach._id);
  }

  @Get('pending-approvals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async findPendingApprovals(@Request() req) {
    if (req.user.role === UserRole.TRIBE) {
      const coach = await this.tribesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
      return this.ordersService.findPendingApprovals(coach._id);
    }
    return this.ordersService.findPendingApprovals();
  }

  @Post()
  create(@Body() orderData: CreateOrderDto) {
    return this.ordersService.create(orderData);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.ordersService.findAll();
  }

  @Get('paginated')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAllPaginated(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.ordersService.findAllPaginated({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      status,
    });
  }

  @Get('tribe')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  findByCoach(@Request() req) {
    return this.findMyOrders(req);
  }

  @Get('by-coach/:coachId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findByCoachPaginated(
    @Param('coachId') coachId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.ordersService.findByCoachPaginated(coachId, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      status,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: OrderStatus,
    @Body('trackingNumber') trackingNumber?: string,
  ) {
    return this.ordersService.updateStatus(id, status, trackingNumber);
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async approveOrder(
    @Param('id') id: string,
    @Body('note') note: string,
    @Body('selectedItemIds') selectedItemIds: string[],
    @Request() req,
  ) {
    const approvedBy = req.user.role === UserRole.ADMIN
      ? 'admin'
      : (req.user.userId || req.user.sub || req.user._id);
    return this.ordersService.approveOrder(id, approvedBy, note, selectedItemIds);
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async rejectOrder(
    @Param('id') id: string,
    @Body('note') note: string,
    @Request() req,
  ) {
    const rejectedBy = req.user.role === UserRole.ADMIN
      ? 'admin'
      : (req.user.userId || req.user.sub || req.user._id);
    return this.ordersService.rejectOrder(id, rejectedBy, note);
  }
}

