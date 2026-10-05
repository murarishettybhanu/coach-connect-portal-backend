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
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { BarcodeType } from '../../schemas/barcode.schema';
import { JwtService } from '@nestjs/jwt';
import { isValidObjectId } from 'mongoose';
import { OrdersService } from './orders.service';
import { TribesService } from '../tribes/tribes.service';
import { UsersService } from '../users/users.service';
import { isLoginTokenPayload } from '../auth/token-claims';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { Throttle } from '@nestjs/throttler';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-status.dto';
import { DownloadMediaDto } from './dto/download-media.dto';
import { DeliverByTrackingDto } from './dto/deliver-by-tracking.dto';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { assertOwnedBy } from '../../common/utils/ownership';
import { AttachAddressDto, UpdateAddressDto } from './dto/attach-address.dto';
import { MarkReturnedDto } from './dto/mark-returned.dto';
import { ReorderDto } from './dto/reorder.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly tribesService: TribesService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * The two public write routes below are also used by signed-in staff, who
   * are exempt from the WhatsApp verification and postal checks a public
   * submission needs (the admin CSV importer depends on it).
   *
   * A token that merely verifies is not enough — the OTP proof token is signed
   * with the same secret. Trusted means: a real session for a user that still
   * exists, who is an ADMIN, or the TRIBE that owns the campaign being
   * submitted against. Anything else is just "not trusted".
   */
  private async isTrustedCaller(
    req: { headers?: { authorization?: string } },
    campaignId?: string,
  ): Promise<boolean> {
    const header = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    let payload: any;
    try {
      payload = this.jwtService.verify(header.slice('Bearer '.length));
    } catch {
      return false;
    }
    // Same rules as JwtStrategy: a login token (not an OTP proof), for a user
    // that still exists, issued since their last password change.
    if (!isLoginTokenPayload(payload) || !isValidObjectId(payload.sub)) return false;

    const user = await this.usersService.findOneById(String(payload.sub));
    if (!user) return false;
    if ((payload.tv ?? 0) !== ((user as any).tokenVersion ?? 0)) return false;
    if (user.role === UserRole.ADMIN) return true;
    if (user.role !== UserRole.TRIBE || !campaignId) return false;
    try {
      const tribeId = await this.tribesService.findIdByUserId(String(user._id));
      return await this.ordersService.isCampaignOwnedBy(campaignId, tribeId);
    } catch {
      return false;
    }
  }

  /**
   * Object-level authorization for every order route a TRIBE can reach: an
   * admin passes, a tribe only for its own orders. Returns the order.
   */
  private async assertOrderOwnership(id: string, req: any, userId: string) {
    const order = await this.ordersService.findOne(id);
    if (req.user.role !== UserRole.ADMIN) {
      const tribeId = await this.tribesService.findIdByUserId(userId);
      assertOwnedBy((order as any).coachId, tribeId, 'Not authorized to access this order');
    }
    return order;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  async findMyOrders(@CurrentUserId() userId: string) {
    const tribeId = await this.tribesService.findIdByUserId(userId);
    return this.ordersService.withPriorClaims(
      await this.ordersService.findByCoach(tribeId),
    );
  }

  @Get('pending-approvals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async findPendingApprovals(@Request() req, @CurrentUserId() userId: string) {
    const tribeId =
      req.user.role === UserRole.TRIBE
        ? await this.tribesService.findIdByUserId(userId)
        : undefined;
    // Each claim carries `priorClaims`, so approvers see repeat claimants.
    return this.ordersService.withPriorClaims(
      await this.ordersService.findPendingApprovals(tribeId),
    );
  }

  @Post()
  async create(@Body() orderData: CreateOrderDto, @Request() req) {
    const trusted = await this.isTrustedCaller(req, orderData.campaignId);
    return this.ordersService.create(orderData, { trusted });
  }

  // Public, after WhatsApp verification: has this number already claimed from
  // this campaign? (The form warns, but still lets them submit.)
  @Get('claim-check')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  claimCheck(
    @Query('campaignId') campaignId: string,
    @Query('phone') phone: string,
    @Query('otpToken') otpToken?: string,
  ) {
    return this.ordersService.claimCheck(campaignId, phone, otpToken);
  }

  // Public: step-2 lookup — does an address-pending claim exist for this phone?
  // `fullName` comes back only with a WhatsApp proof token for that phone.
  @Get('pending-claim')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  findPendingClaim(
    @Query('campaignId') campaignId: string,
    @Query('phone') phone: string,
    @Query('otpToken') otpToken?: string,
  ) {
    return this.ordersService.findPendingClaim(campaignId, phone, otpToken);
  }

  // Public: attach a delivery address to address-pending claim(s) by campaign + phone.
  @Post('attach-address')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async attachAddress(@Body() dto: AttachAddressDto, @Request() req) {
    return this.ordersService.attachAddressByPhone(
      dto.campaignId,
      dto.phone,
      dto.address,
      {
        trusted: await this.isTrustedCaller(req, dto.campaignId),
        otpToken: dto.otpToken,
        termsAccepted: dto.termsAccepted,
      },
    );
  }

  // Admin: download a ZIP of customer-uploaded PHOTO media for the given orders.
  @Post('media/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async downloadMedia(@Body() dto: DownloadMediaDto, @Res() res: Response) {
    await this.ordersService.streamMediaZip(dto.orderIds || [], res);
  }

  // Admin "Mark delivered" tool: check pasted barcodes (read-only), then mark
  // the dispatched orders they belong to as delivered.
  @Post('deliver-by-tracking/preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  previewDeliverByTracking(@Body() dto: DeliverByTrackingDto) {
    return this.ordersService.previewDeliverByTracking(dto.codes);
  }

  @Post('deliver-by-tracking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  deliverByTracking(@Body() dto: DeliverByTrackingDto) {
    return this.ordersService.deliverByTracking(dto.codes);
  }

  // Admin: list soft-deleted orders (optionally scoped to a tribe).
  @Get('deleted')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findDeleted(
    @Query('coachId') coachId?: string,
    @Query('campaignId') campaignId?: string,
  ) {
    return this.ordersService.findDeleted(coachId, campaignId);
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
    @Query('campaignId') campaignId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findReturned({
      coachId,
      campaignId,
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
    @Query('campaignId') campaignId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findRejected({
      coachId,
      campaignId,
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
    @CurrentUserId() userId: string,
  ) {
    let coachId: string | undefined;
    if (req.user.role !== UserRole.ADMIN) {
      coachId = await this.tribesService.findIdByUserId(userId);
    }
    return this.ordersService.findAddressPending(campaignId, coachId);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async findAll() {
    return this.ordersService.withPriorClaims(await this.ordersService.findAll());
  }

  // Admin: orders whose phone number is on another order of the same tribe.
  @Get('duplicates')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async findDuplicates(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('coachId') coachId?: string | string[],
    @Query('campaignId') campaignId?: string | string[],
  ) {
    return this.ordersService.withPriorClaimsPage(
      await this.ordersService.findDuplicates({
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        search,
        status,
        coachId,
        campaignId,
      }),
    );
  }

  @Get('paginated')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async findAllPaginated(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('coachId') coachId?: string | string[],
    @Query('campaignId') campaignId?: string | string[],
  ) {
    return this.ordersService.withPriorClaimsPage(
      await this.ordersService.findAllPaginated({
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        search,
        status,
        coachId,
        campaignId,
      }),
    );
  }

  @Get('tribe')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TRIBE)
  findByCoach(@CurrentUserId() userId: string) {
    return this.findMyOrders(userId);
  }

  @Get('by-coach/:coachId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async findByCoachPaginated(
    @Param('coachId') coachId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('campaignId') campaignId?: string | string[],
  ) {
    return this.ordersService.withPriorClaimsPage(
      await this.ordersService.findByCoachPaginated(coachId, {
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        search,
        status,
        campaignId,
      }),
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async findOne(
    @Param('id') id: string,
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    // Object-level authorization: a tribe may only read its own orders.
    const order = await this.assertOrderOwnership(id, req, userId);
    const [withClaims] = await this.ordersService.withPriorClaims([order]);
    return withClaims;
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateStatus(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateStatus(
      id,
      dto.status,
      dto.trackingNumber,
      dto.deliveryType,
    );
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async approveOrder(
    @Param('id') id: string,
    @Body('note') note: string,
    @Body('selectedItemIds') selectedItemIds: string[],
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    await this.assertOrderOwnership(id, req, userId);
    const approvedBy = req.user.role === UserRole.ADMIN ? 'admin' : userId;
    return this.ordersService.approveOrder(id, approvedBy, note, selectedItemIds);
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async rejectOrder(
    @Param('id') id: string,
    @Body('note') note: string,
    @Request() req,
    @CurrentUserId() userId: string,
  ) {
    await this.assertOrderOwnership(id, req, userId);
    const rejectedBy = req.user.role === UserRole.ADMIN ? 'admin' : userId;
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
    @CurrentUserId() userId: string,
  ) {
    // Object-level authorization: a tribe may only update its own orders.
    await this.assertOrderOwnership(id, req, userId);
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
  revertStatus(@Param('id') id: string, @CurrentUserId() userId: string) {
    return this.ordersService.revertStatus(id, userId || undefined);
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

