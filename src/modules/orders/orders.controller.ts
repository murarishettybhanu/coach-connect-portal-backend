import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Res,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { Throttle } from '@nestjs/throttler';
import { OrderStatus } from '../../schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { AttachAddressDto, UpdateAddressDto } from './dto/attach-address.dto';

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

  // Public: step-2 lookup — does an address-pending claim exist for this phone?
  @Get('pending-claim')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  findPendingClaim(
    @Query('campaignId') campaignId: string,
    @Query('phone') phone: string,
  ) {
    return this.ordersService.findPendingClaim(campaignId, phone);
  }

  // Public: attach a delivery address to address-pending claim(s) by campaign + phone.
  @Post('attach-address')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  attachAddress(@Body() dto: AttachAddressDto) {
    return this.ordersService.attachAddressByPhone(
      dto.campaignId,
      dto.phone,
      dto.address,
    );
  }

  // Admin: download a ZIP of customer-uploaded PHOTO media for the given orders.
  @Post('media/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async downloadMedia(@Body('orderIds') orderIds: string[], @Res() res: Response) {
    await this.ordersService.streamMediaZip(orderIds || [], res);
  }

  // Tribe/Admin: list a campaign's address-pending claims (bulk upload + count).
  @Get('address-pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async findAddressPending(
    @Query('campaignId') campaignId: string,
    @Request() req,
  ) {
    let coachId: string | undefined;
    if (req.user.role !== UserRole.ADMIN) {
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      coachId = String(coach._id);
    }
    return this.ordersService.findAddressPending(campaignId, coachId);
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
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async findOne(@Param('id') id: string, @Request() req) {
    const order = await this.ordersService.findOne(id);
    // Object-level authorization: a tribe may only read its own orders.
    if (req.user.role !== UserRole.ADMIN) {
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      const orderCoachId = String((order as any).coachId?._id || (order as any).coachId);
      if (orderCoachId !== String(coach._id)) {
        throw new ForbiddenException('Not authorized to view this order');
      }
    }
    return order;
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

  // Tribe/Admin: attach/replace the delivery address on a specific claim (bulk upload).
  @Patch(':id/address')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async updateAddress(
    @Param('id') id: string,
    @Body() address: UpdateAddressDto,
    @Request() req,
  ) {
    // Object-level authorization: a tribe may only update its own orders.
    if (req.user.role !== UserRole.ADMIN) {
      const order = await this.ordersService.findOne(id);
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      const orderCoachId = String((order as any).coachId?._id || (order as any).coachId);
      if (orderCoachId !== String(coach._id)) {
        throw new ForbiddenException('Not authorized to update this order');
      }
    }
    return this.ordersService.updateAddress(id, address);
  }
}

