import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CoachesService } from '../coaches/coaches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { OrderStatus } from '../../schemas/order.schema';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly coachesService: CoachesService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.COACH)
  async findMyOrders(@Request() req) {
    const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
    return this.ordersService.findByCoach(coach._id);
  }

  @Get('pending-approvals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COACH)
  async findPendingApprovals(@Request() req) {
    if (req.user.role === UserRole.COACH) {
      const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
      return this.ordersService.findPendingApprovals(coach._id);
    }
    return this.ordersService.findPendingApprovals();
  }

  @Post()
  create(@Body() orderData: any) {
    return this.ordersService.create(orderData);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.ordersService.findAll();
  }

  @Get('coach')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.COACH)
  findByCoach(@Request() req) {
    return this.findMyOrders(req);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateStatus(@Param('id') id: string, @Body('status') status: OrderStatus) {
    return this.ordersService.updateStatus(id, status);
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COACH)
  async approveOrder(
    @Param('id') id: string,
    @Body('note') note: string,
    @Request() req,
  ) {
    const approvedBy = req.user.role === UserRole.ADMIN
      ? 'admin'
      : (req.user.userId || req.user.sub || req.user._id);
    return this.ordersService.approveOrder(id, approvedBy, note);
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COACH)
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

