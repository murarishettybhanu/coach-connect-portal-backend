import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import type { Response } from 'express';
import archiver = require('archiver');
import { Order, OrderStatus, OrderType, ApprovalStatus } from '../../schemas/order.schema';
import { Campaign, CampaignFormType } from '../../schemas/campaign.schema';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../schemas/transaction.schema';
import { BarcodesService } from '../barcodes/barcodes.service';
import { BarcodeType } from '../../schemas/barcode.schema';
import { WhatsappOtpService } from '../whatsapp/whatsapp-otp.service';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    private productsService: ProductsService,
    private transactionsService: TransactionsService,
    private barcodesService: BarcodesService,
    private otpService: WhatsappOtpService,
  ) {}

  // Public endpoint — NEVER trust client-supplied coachId / type / prices.
  // The campaign (or the products themselves) is the source of truth; this
  // prevents forged orders that mint commission to arbitrary tribes.
  async create(orderData: any, opts: { trusted?: boolean } = {}): Promise<Order> {
    const rawItems: any[] = orderData.items || [];
    if (!rawItems.length) throw new BadRequestException('Order has no items');

    // Campaign claims come from public forms where the phone number is the only
    // identity we have, so it has to be proven over WhatsApp. `trusted` covers
    // signed-in staff, who never see a claim form.
    if (orderData.campaignId && !opts.trusted) {
      this.requireVerifiedPhone(orderData.otpToken, orderData.shippingAddress?.phone);
      this.validatePublicAddress(orderData.shippingAddress);
    }

    // If a campaign is referenced, it dictates coach, type, and per-item prices.
    let campaign: any = null;
    if (orderData.campaignId) {
      campaign = await this.campaignModel.findById(orderData.campaignId).exec();
      if (!campaign) throw new NotFoundException('Campaign not found');
      if (campaign.status && campaign.status !== 'ACTIVE') {
        throw new BadRequestException('This campaign is not accepting orders');
      }
    }

    const type: OrderType = campaign ? campaign.type : OrderType.STORE_SALE;
    const campaignPrice = new Map<string, number>();
    if (campaign) {
      for (const cp of campaign.products || []) {
        campaignPrice.set(String(cp.productId), cp.retailPrice || 0);
      }
    }

    let coachId: string | null = campaign ? String(campaign.coachId) : null;
    let totalCommission = 0;
    let totalAmount = 0;
    let totalCost = 0;
    const itemsWithDetails: any[] = [];
    // Track atomic decrements so we can roll them back on any failure.
    const decremented: { id: string; qty: number }[] = [];

    try {
      for (const item of rawItems) {
        const product = await this.productsService.findOne(item.productId);

        // All items must belong to one tribe; derive it server-side.
        if (!coachId) coachId = String(product.coachId);
        else if (String(product.coachId) !== coachId) {
          throw new BadRequestException('All items must belong to the same tribe');
        }
        if (campaign && !campaignPrice.has(String(product._id))) {
          throw new BadRequestException('Product is not part of this campaign');
        }

        const quantity = Math.max(1, Number(item.quantity) || 1);
        // SERVER-DERIVED price — ignore whatever the client sent.
        const retailPrice =
          type === OrderType.STORE_SALE
            ? campaign
              ? campaignPrice.get(String(product._id)) || 0
              : product.retailPrice || 0
            : 0;

        let commission = 0;
        if (type === OrderType.STORE_SALE) {
          commission = (retailPrice - product.baseProductionCost) * quantity;
          totalAmount += retailPrice * quantity;
        }
        totalCost += product.baseProductionCost * quantity;
        totalCommission += commission;

        // Atomic stock check + decrement.
        const ok = await this.productsService.decrementStock(String(product._id), quantity);
        if (!ok) {
          throw new BadRequestException(`Insufficient stock for ${product.name}`);
        }
        decremented.push({ id: String(product._id), qty: quantity });

        itemsWithDetails.push({
          productId: product._id,
          quantity,
          retailPrice,
          baseCost: product.baseProductionCost,
          commission,
          ...(item.customizationType
            ? { customizationType: item.customizationType, customizationValue: item.customizationValue }
            : {}),
        });
      }
    } catch (err) {
      // Compensate: restore any stock already decremented in this attempt.
      for (const d of decremented) await this.productsService.incrementStock(d.id, d.qty);
      throw err;
    }

    if (!coachId) throw new BadRequestException('Could not resolve the tribe for this order');

    const isWelcomeKit = type === OrderType.WELCOME_KIT;

    // Address handling depends on the campaign's form type. "Without address"
    // campaigns (WELCOME_KIT only) capture contact now; the delivery address is
    // attached later via the address page or bulk upload.
    const formType = campaign?.formType || CampaignFormType.WITH_ADDRESS;
    const addr = orderData.shippingAddress || {};
    if (!addr.fullName || !addr.phone) {
      throw new BadRequestException('Name and phone are required');
    }

    let addressPending = false;
    let shippingAddress: any;
    if (formType === CampaignFormType.WITHOUT_ADDRESS) {
      if (!isWelcomeKit) {
        throw new BadRequestException(
          'Address-less claims are only allowed for welcome-kit campaigns',
        );
      }
      addressPending = true;
      // Store contact only; the delivery address is filled in later.
      shippingAddress = {
        fullName: addr.fullName,
        phone: addr.phone,
        ...(addr.email ? { email: addr.email } : {}),
      };
    } else {
      // Full delivery address is required up front.
      const missing = ['addressLine1', 'city', 'state', 'pincode'].filter(
        (f) => !addr[f],
      );
      if (missing.length) {
        throw new BadRequestException(
          `Missing address fields: ${missing.join(', ')}`,
        );
      }
      shippingAddress = addr;
    }

    // Explicit build — do NOT spread client orderData (mass-assignment guard).
    const order = new this.orderModel({
      coachId,
      campaignId: orderData.campaignId,
      type,
      // Inherit the campaign's delivery type only when it set one; otherwise leave
      // it unset (store sales + campaigns with no type) so it must be chosen at dispatch.
      deliveryType: campaign?.deliveryType || null,
      shippingAddress,
      addressPending,
      items: itemsWithDetails,
      totalCommission,
      totalAmount,
      totalCost,
      status: OrderStatus.NEW,
      approvalStatus: isWelcomeKit ? ApprovalStatus.PENDING : null,
      statusHistory: [{
        status: OrderStatus.NEW,
        at: new Date(),
        note: isWelcomeKit ? 'Order placed — awaiting approval' : 'Order placed',
      }],
    });

    const savedOrder = await order.save();

    // Increment campaign claims if applicable
    if (orderData.campaignId) {
      await this.campaignModel.findByIdAndUpdate(orderData.campaignId, {
        $inc: { claims: 1 }
      });
    }

    // Record transactions only for store sales (welcome kits deferred until approval)
    if (type === OrderType.STORE_SALE && totalCommission > 0) {
      await this.transactionsService.create({
        coachId,
        type: TransactionType.COMMISSION,
        amount: totalCommission,
        orderId: savedOrder._id as any,
        description: `Commission from Order #${savedOrder._id.toString().slice(-6)}`,
      });
    }

    return savedOrder;
  }

  // ---- Address-pending claims ("without address" campaigns) ----

  // Merge a supplied delivery address onto a claim, preserving the existing
  // contact (fullName/phone/email) when the incoming payload omits it.
  private mergeAddress(existing: any, incoming: any) {
    const e = existing || {};
    return {
      fullName: incoming.fullName || e.fullName,
      addressLine1: incoming.addressLine1,
      addressLine2: incoming.addressLine2,
      landmark: incoming.landmark,
      sectorVillage: incoming.sectorVillage,
      city: incoming.city,
      district: incoming.district,
      state: incoming.state,
      pincode: incoming.pincode,
      phone: incoming.phone || e.phone,
      email: incoming.email || e.email,
    };
  }

  // Public: does an address-pending claim exist for this campaign + phone?
  async findPendingClaim(campaignId: string, phone: string) {
    const cleanPhone = String(phone || '').trim();
    if (!isValidObjectId(campaignId) || !cleanPhone) return { found: false, count: 0 };
    const orders = await this.orderModel
      .find({ campaignId, addressPending: true, 'shippingAddress.phone': cleanPhone, isDeleted: { $ne: true } } as any)
      .select('shippingAddress createdAt')
      .sort({ createdAt: -1 })
      .exec();
    return {
      found: orders.length > 0,
      count: orders.length,
      fullName: orders[0]?.shippingAddress?.fullName,
    };
  }

  // Public: fill the delivery address on ALL address-pending claims matching
  // campaign + phone. Never touches already-completed (addressPending:false) orders.
  /**
   * Postal rules for addresses typed into the public forms. Mirrors the
   * client-side checks so the API can't be used to skip them — a bad address
   * here becomes a parcel that ships and comes back.
   */
  private validatePublicAddress(address: any) {
    if (!/^[6-9]\d{9}$/.test(String(address?.phone ?? ''))) {
      throw new BadRequestException(
        'Enter a valid 10-digit mobile number starting with 6-9',
      );
    }

    // Contact-only claims ("without address" campaigns) have no postal fields
    // yet; they're checked when the address is attached later.
    if (!address?.addressLine1) return;

    if (!String(address.landmark ?? '').trim()) {
      throw new BadRequestException('Landmark is required');
    }
    if (!String(address.sectorVillage ?? '').trim()) {
      throw new BadRequestException('Sector / Village is required');
    }
  }

  /**
   * Rejects unless the caller holds a valid proof token for this phone number,
   * issued by the WhatsApp OTP flow the public forms go through.
   */
  private requireVerifiedPhone(otpToken: string | undefined, phone: string) {
    if (!otpToken) {
      throw new BadRequestException(
        'Verify your WhatsApp number before submitting this form',
      );
    }
    const proof = this.otpService.checkProof(otpToken, phone);
    if (!proof.ok) {
      throw new BadRequestException(
        proof.reason === 'number-mismatch'
          ? 'The verified number does not match the number on this form'
          : 'Your verification has expired — verify your WhatsApp number again',
      );
    }
  }

  async attachAddressByPhone(
    campaignId: string,
    phone: string,
    address: any,
    opts: { trusted?: boolean; otpToken?: string } = {},
  ) {
    // This decides where someone else's kit ships, so a phone number alone is
    // not enough.
    if (!opts.trusted) {
      this.requireVerifiedPhone(opts.otpToken, phone);
      this.validatePublicAddress({ ...address, phone });
    }

    const cleanPhone = String(phone || '').trim();
    const orders = await this.orderModel
      .find({ campaignId, addressPending: true, 'shippingAddress.phone': cleanPhone, isDeleted: { $ne: true } } as any)
      .exec();
    if (!orders.length) {
      throw new NotFoundException('No pending claim found for this phone number');
    }
    for (const order of orders) {
      order.shippingAddress = this.mergeAddress(order.shippingAddress, address);
      order.addressPending = false;
      order.markModified('shippingAddress');
      await order.save();
    }
    return { updated: orders.length };
  }

  // Tribe/Admin: list a campaign's address-pending claims (bulk upload + count).
  // When coachId is given (tribe caller), scoped to that tribe's own orders.
  async findAddressPending(campaignId: string, coachId?: string): Promise<Order[]> {
    if (!isValidObjectId(campaignId)) return [];
    const filter: any = { campaignId, addressPending: true, isDeleted: { $ne: true } };
    if (coachId) filter.coachId = coachId;
    return this.orderModel
      .find(filter)
      .select('shippingAddress createdAt addressPending')
      .sort({ createdAt: -1 })
      .exec();
  }

  // Tribe/Admin: attach/replace the delivery address on a specific claim.
  async updateAddress(id: string, address: any): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    order.shippingAddress = this.mergeAddress(order.shippingAddress, address);
    order.addressPending = false;
    order.markModified('shippingAddress');
    return order.save();
  }

  // Admin: SOFT-delete an order — hidden from all lists/pipeline, recoverable via
  // restore. Frees stock (unless already shipped/cancelled) and removes ledger
  // entries so a deleted order stops counting toward the tribe's balance.
  async deleteOrder(id: string): Promise<void> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.isDeleted) return;

    if (order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.CANCELLED) {
      for (const item of order.items) {
        const pid = (item.productId as any)?._id || item.productId;
        if (pid) await this.productsService.incrementStock(String(pid), item.quantity);
      }
    }
    // Free the barcode back to the pool only while the order is still in the
    // "Ready to Ship" (PACKED) stage — it hasn't physically shipped yet. Once
    // DISPATCHED/DELIVERED the barcode is on a real parcel and must never be reused.
    if (order.status === OrderStatus.PACKED) {
      await this.barcodesService.releaseFromOrder(id);
      order.trackingNumber = undefined as any;
      order.barcodePending = false;
    }
    await this.transactionsService.deleteByOrder(id);
    order.isDeleted = true;
    order.deletedAt = new Date();
    await order.save();
  }

  // Admin: restore a soft-deleted order. Re-decrements stock (best-effort) and
  // re-creates its commission ledger entry where applicable.
  async restoreOrder(id: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (!order.isDeleted) return order;

    if (order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.CANCELLED) {
      for (const item of order.items) {
        const pid = (item.productId as any)?._id || item.productId;
        if (pid) await this.productsService.decrementStock(String(pid), item.quantity);
      }
    }
    const eligibleForCommission =
      order.totalCommission > 0 &&
      (order.type === OrderType.STORE_SALE ||
        (order.type === OrderType.WELCOME_KIT && order.approvalStatus === ApprovalStatus.APPROVED));
    if (eligibleForCommission) {
      await this.transactionsService.create({
        coachId: order.coachId as any,
        type: TransactionType.COMMISSION,
        amount: order.totalCommission,
        orderId: order._id as any,
        description: `Commission from restored Order #${order._id.toString().slice(-6)}`,
      });
    }
    // Re-claim a barcode if the order was in the "Ready to Ship" (PACKED) stage —
    // its previous one was freed on delete.
    if (order.status === OrderStatus.PACKED && !order.trackingNumber) {
      const type = (order.deliveryType as BarcodeType | null) || null;
      if (type) {
        const bc = await this.barcodesService.assignToOrder(id, type);
        if (bc) {
          order.trackingNumber = bc.code;
          order.barcodePending = false;
        } else {
          order.barcodePending = true;
        }
      } else {
        order.barcodePending = true;
      }
    }
    order.isDeleted = false;
    order.deletedAt = undefined as any;
    return order.save();
  }

  // Admin: list soft-deleted orders (optionally scoped to a tribe).
  async findDeleted(coachId?: string): Promise<Order[]> {
    const filter: any = { isDeleted: true };
    if (coachId) filter.coachId = coachId;
    return this.orderModel
      .find(filter)
      .sort({ deletedAt: -1 })
      .populate('items.productId')
      .populate('campaignId', 'name type')
      .exec();
  }

  // Admin: stream a ZIP of the customer-uploaded PHOTO media for the given orders.
  // Images are fetched server-side from their public URLs (no browser CORS issues).
  async streamMediaZip(orderIds: string[], res: Response): Promise<void> {
    const ids = (orderIds || []).filter((id) => isValidObjectId(id));
    const orders = ids.length
      ? await this.orderModel.find({ _id: { $in: ids } } as any).exec()
      : [];

    const archive = archiver('zip', { zlib: { level: 5 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="order-media.zip"');
    archive.on('error', () => {
      try { if (!res.headersSent) res.status(500); res.end(); } catch { /* noop */ }
    });
    archive.pipe(res);

    const used = new Set<string>();
    for (const o of orders) {
      const base =
        (String((o.shippingAddress as any)?.fullName || 'order').replace(/[^\w-]+/g, '_').slice(0, 40)) || 'order';
      const short = String(o._id).slice(-6);
      let idx = 0;
      for (const item of ((o.items as any[]) || [])) {
        if (item.customizationType !== 'PHOTO' || !item.customizationValue) continue;
        try {
          const resp = await fetch(String(item.customizationValue));
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          const ext = (String(item.customizationValue).split('?')[0].split('.').pop() || 'jpg').slice(0, 5);
          let name = `${base}-${short}-${++idx}.${ext}`;
          while (used.has(name)) name = `${base}-${short}-${++idx}.${ext}`;
          used.add(name);
          archive.append(buf, { name });
        } catch {
          // skip unreachable media
        }
      }
    }
    await archive.finalize();
  }

  async approveOrder(
    id: string,
    approvedBy: string,
    note?: string,
    selectedItemIds?: string[],
  ): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    if (order.approvalStatus !== ApprovalStatus.PENDING) throw new BadRequestException('Order is not pending approval');

    const now = new Date();
    order.approvalStatus = ApprovalStatus.APPROVED;
    order.approvedBy = approvedBy;
    order.approvedAt = now;
    if (note) order.approvalNote = note;
    if (!order.statusHistory) order.statusHistory = [] as any;
    order.statusHistory.push({ status: 'APPROVED', at: now, note });

    // If a selection was provided, mark items not in the list as unselected
    // (item is kept in the order, only its `selected` flag changes).
    if (Array.isArray(selectedItemIds)) {
      const selectedSet = new Set(selectedItemIds.map(String));
      order.items.forEach((item: any) => {
        item.selected = selectedSet.has(item._id.toString());
      });
      order.markModified('items');
    }

    const savedOrder = await order.save();

    // Record commission transaction on approval if applicable
    if (order.totalCommission > 0) {
      await this.transactionsService.create({
        coachId: order.coachId as any,
        type: TransactionType.COMMISSION,
        amount: order.totalCommission,
        orderId: savedOrder._id as any,
        description: `Commission from Approved Kit Order #${savedOrder._id.toString().slice(-6)}`,
      });
    }

    return savedOrder;
  }

  async rejectOrder(id: string, rejectedBy: string, note?: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    if (order.approvalStatus !== ApprovalStatus.PENDING) throw new BadRequestException('Order is not pending approval');

    const now = new Date();
    order.approvalStatus = ApprovalStatus.REJECTED;
    order.approvedBy = rejectedBy;
    order.approvedAt = now;
    order.status = OrderStatus.CANCELLED;
    if (note) order.approvalNote = note;
    if (!order.statusHistory) order.statusHistory = [] as any;
    order.statusHistory.push({ status: 'REJECTED', at: now, note });

    // Restore stock atomically.
    for (const item of order.items) {
      const pid = (item.productId as any)?._id || item.productId;
      await this.productsService.incrementStock(String(pid), item.quantity);
    }

    return order.save();
  }

  async findPendingApprovals(coachId?: string): Promise<Order[]> {
    const filter: any = { approvalStatus: ApprovalStatus.PENDING, isDeleted: { $ne: true } };
    if (coachId) filter.coachId = coachId;
    return this.orderModel.find(filter)
      .sort({ createdAt: -1 })
      .populate('coachId')
      .populate('items.productId')
      .exec();
  }

  async findAll(): Promise<Order[]> {
    return this.orderModel.find({ isDeleted: { $ne: true } } as any).sort({ createdAt: -1 }).populate('coachId').populate('items.productId').populate('campaignId', 'name type').exec();
  }

  async findByCoach(coachId: string): Promise<Order[]> {
    return this.orderModel.find({ coachId, isDeleted: { $ne: true } } as any).sort({ createdAt: -1 }).populate('items.productId').populate('campaignId', 'name type').exec();
  }

  async findByCoachPaginated(
    coachId: string,
    options: { page?: number; limit?: number; search?: string; status?: string } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: any = { coachId, isDeleted: { $ne: true } };

    if (options.status) {
      filter.status = options.status;
      // "New" excludes welcome-kit orders still awaiting approval.
      if (options.status === OrderStatus.NEW) {
        filter.approvalStatus = { $ne: ApprovalStatus.PENDING };
      }
    }

    // Delivered orders sort by delivery time (newest first); fall back to creation time.
    const sort: any = options.status === OrderStatus.DELIVERED
      ? { deliveredAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const search = options.search?.trim();
    if (search) {
      // Escape regex special chars so user input is treated literally
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.email': regex },
        { 'shippingAddress.city': regex },
        { 'shippingAddress.state': regex },
        { status: regex },
        { type: regex },
        { trackingNumber: regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .populate('campaignId', 'name type')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  // Same as findByCoachPaginated but across ALL coaches (admin Orders page).
  async findAllPaginated(
    options: { page?: number; limit?: number; search?: string; status?: string } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: any = { isDeleted: { $ne: true } };
    if (options.status) {
      filter.status = options.status;
      // "New" excludes welcome-kit orders still awaiting approval — those live in
      // the approvals queue, not the New shipping bucket.
      if (options.status === OrderStatus.NEW) {
        filter.approvalStatus = { $ne: ApprovalStatus.PENDING };
      }
    }

    const sort: any = options.status === OrderStatus.DELIVERED
      ? { deliveredAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const search = options.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.email': regex },
        { 'shippingAddress.city': regex },
        { 'shippingAddress.state': regex },
        { status: regex },
        { type: regex },
        { trackingNumber: regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .populate({ path: 'coachId', populate: { path: 'userId', select: 'name email' } })
        .populate('campaignId', 'name type')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderModel.findById(id).populate('items.productId').exec();
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    trackingNumber?: string,
    deliveryType?: BarcodeType,
  ): Promise<Order> {
    const now = new Date();
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);

    // Auto-assign a postal tracking barcode when an order is packed / made ready to
    // ship (the "Pack" action moves NEW → PACKED). Idempotent (keeps an already-
    // assigned barcode) and atomic (never shared across orders). Skipped when an
    // explicit tracking number is supplied. If no barcode of the order's delivery
    // type is available, the order still advances but is flagged `barcodePending`
    // so it can be assigned once more are uploaded.
    if (status === OrderStatus.PACKED && !(trackingNumber && trackingNumber.trim())) {
      // Resolve the delivery type: an explicit choice at pack time (confirmation
      // dialog) wins, otherwise the order's own type. NEVER default silently — a
      // barcode is a real consignment, so an unset type must be chosen first.
      const resolvedType = deliveryType || (order.deliveryType as BarcodeType | null);
      if (!resolvedType) {
        throw new BadRequestException(
          'Choose a delivery type (Speed Post or Business Parcel) before packing this order',
        );
      }
      if (deliveryType && deliveryType !== order.deliveryType) {
        order.deliveryType = deliveryType;
      }
      const barcode = await this.barcodesService.assignToOrder(id, resolvedType);
      if (barcode) {
        order.trackingNumber = barcode.code;
        order.barcodePending = false;
      } else {
        order.barcodePending = true;
      }
    }

    order.status = status;
    if (status === OrderStatus.DELIVERED) order.deliveredAt = now;
    // An explicit tracking number (e.g. entered at dispatch) overrides the barcode.
    if (trackingNumber && trackingNumber.trim()) {
      order.trackingNumber = trackingNumber.trim();
    }
    if (!order.statusHistory) order.statusHistory = [] as any;
    order.statusHistory.push({ status, at: now });
    return order.save();
  }

  // Admin: change an order's delivery type before it is dispatched. A NEW order has
  // no barcode yet — the barcode of the chosen type is claimed later when the order
  // is packed & dispatched — so this simply records the delivery type. Rejected once
  // the order has shipped (its barcode is on a real parcel and must not change).
  async changeDeliveryType(id: string, newType: BarcodeType): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.status !== OrderStatus.NEW) {
      throw new BadRequestException('Delivery type can only be changed before the order is dispatched');
    }
    if (order.deliveryType === newType) return order;
    order.deliveryType = newType;
    return order.save();
  }
}

