import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Res,
  Delete,
  UseGuards,
  Request,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { BarcodeType } from '../../schemas/barcode.schema';
import { JwtService } from '@nestjs/jwt';
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
import { MarkReturnedDto } from './dto/mark-returned.dto';
import { ReorderDto } from './dto/reorder.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly tribesService: TribesService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * The two public write routes below are also used by signed-in staff. A valid
   * session exempts the caller from the WhatsApp verification a public
   * submission needs; a missing or invalid token just means "not trusted".
   */
  private isSignedIn(req: { headers?: { authorization?: string } }): boolean {
    const header = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    try {
      this.jwtService.verify(header.slice('Bearer '.length));
      return true;
    } catch {
      return false;
    }
  }

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
  create(@Body() orderData: CreateOrderDto, @Request() req) {
    return this.ordersService.create(orderData, { trusted: this.isSignedIn(req) });
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
  attachAddress(@Body() dto: AttachAddressDto, @Request() req) {
    return this.ordersService.attachAddressByPhone(
      dto.campaignId,
      dto.phone,
      dto.address,
      {
        trusted: this.isSignedIn(req),
        otpToken: dto.otpToken,
        termsAccepted: dto.termsAccepted,
      },
    );
  }

  // Admin: download a ZIP of customer-uploaded PHOTO media for the given orders.
  @Post('media/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async downloadMedia(@Body('orderIds') orderIds: string[], @Res() res: Response) {
    await this.ordersService.streamMediaZip(orderIds || [], res);
  }

  // Admin: list soft-deleted orders (optionally scoped to a tribe).
  @Get('deleted')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findDeleted(@Query('coachId') coachId?: string) {
    return this.ordersService.findDeleted(coachId);
  }

  // Admin: log a parcel that came back, by the tracking number on the label.
  @Post('returned')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  markReturned(@Body() dto: MarkReturnedDto) {
    return this.ordersService.markReturned(dto.trackingNumber, dto.note);
  }

  // Admin: returned parcels — paginated + searchable.
  @Get('returned')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findReturned(
    @Query('coachId') coachId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findReturned({
      coachId,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
      search,
    });
  }

  // Admin: send a returned parcel out again as a fresh order.
  @Post(':id/reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  reorder(@Param('id') id: string, @Body() dto: ReorderDto) {
    return this.ordersService.reorderReturned(id, dto?.address);
  }

  // Admin: rejected claims — paginated + searchable (they're hidden everywhere else).
  @Get('rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findRejected(
    @Query('coachId') coachId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findRejected({
      coachId,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
      search,
    });
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
    @Query('coachId') coachId?: string,
  ) {
    return this.ordersService.findAllPaginated({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      status,
      coachId,
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
    @Body('deliveryType') deliveryType?: BarcodeType,
  ) {
    if (deliveryType && !Object.values(BarcodeType).includes(deliveryType)) {
      throw new BadRequestException('Invalid delivery type');
    }
    return this.ordersService.updateStatus(id, status, trackingNumber, deliveryType);
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

  // Admin: soft-delete an order (recoverable).
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.ordersService.deleteOrder(id);
    return { success: true };
  }

  // Admin: move an order back one stage (Delivered → Dispatched → Ready to Ship).
  @Patch(':id/revert-status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  revertStatus(@Param('id') id: string, @Request() req) {
    const userId = req.user?.userId || req.user?.sub || req.user?._id;
    return this.ordersService.revertStatus(id, userId ? String(userId) : undefined);
  }

  // Admin: restore a soft-deleted order.
  @Patch(':id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@Param('id') id: string) {
    return this.ordersService.restoreOrder(id);
  }

  // Admin: change delivery type of a PACKED order (swaps its barcode atomically).
  @Patch(':id/delivery-type')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  changeDeliveryType(
    @Param('id') id: string,
    @Body('deliveryType') deliveryType: BarcodeType,
  ) {
    if (!Object.values(BarcodeType).includes(deliveryType)) {
      throw new BadRequestException('Invalid delivery type');
    }
    return this.ordersService.changeDeliveryType(id, deliveryType);
  }
}

