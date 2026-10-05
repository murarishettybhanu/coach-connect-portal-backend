import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import type { Response } from 'express';
import archiver = require('archiver');
import { Order, OrderStatus, OrderType, ApprovalStatus } from '../../schemas/order.schema';
import { refIdOf } from '../../common/utils/ownership';
import { Campaign, CampaignFormType } from '../../schemas/campaign.schema';
import { TribeKit } from '../../schemas/tribe-kit.schema';
import { allocate, allocateUnitPrices, roundMoney } from '../../common/kit-pricing';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../schemas/transaction.schema';
import { BarcodesService } from '../barcodes/barcodes.service';
import { BarcodeType } from '../../schemas/barcode.schema';
import { WhatsappOtpService } from '../whatsapp/whatsapp-otp.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { MAX_TRACKING_CODES, uniqueCodes } from './tracking-codes';
import { titleCaseName } from '../../common/utils/name.util';
import { isAllowedMediaUrl } from '../../common/utils/media-url';
import { pageSizeOf } from '../../common/utils/pagination.util';
import { andCampaignFilter, coachIdsFilter } from '../../common/utils/coach-ids.util';
import { MAX_MEDIA_ORDERS } from './dto/download-media.dto';
import { TribeMembersService } from '../tribe-members/tribe-members.service';
import { TribesService } from '../tribes/tribes.service';

// A rejected claim is dead: no dispatch, no commission. Order listings exclude
// them so the tables only hold work that still matters. `$ne` also matches the
// null/absent approvalStatus that store sales carry.
const NOT_REJECTED = { approvalStatus: { $ne: ApprovalStatus.REJECTED } };

// Statuses whose stock is still out of the warehouse on the order's behalf:
// the units leave the books at creation and come back if the order dies
// before dispatch. Dispatched parcels are gone; a return restocks on arrival.
const ON_SHELF = [OrderStatus.NEW, OrderStatus.PACKED];

// The one precondition for approving or rejecting a claim.
const PENDING_KIT = {
  type: OrderType.WELCOME_KIT,
  approvalStatus: ApprovalStatus.PENDING,
  isDeleted: { $ne: true },
};

/**
 * Forward moves PATCH /orders/:id/status may make. Backwards is
 * revert-status; RETURNED is POST /orders/returned. Same-status entries let
 * a pack retry a pending barcode and a dispatch correct its tracking number.
 * NEW → DISPATCHED is the admin board's "dispatch without packing".
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.NEW]: [OrderStatus.PACKED, OrderStatus.DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.PACKED]: [OrderStatus.PACKED, OrderStatus.DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.DISPATCHED]: [OrderStatus.DISPATCHED, OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.RETURNED]: [],
  [OrderStatus.CANCELLED]: [],
};

export type TrackingDeliveryState =
  | 'READY'
  | 'ALREADY_DELIVERED'
  | 'CLOSED'
  | 'AWAITING_APPROVAL'
  | 'MULTIPLE'
  | 'NOT_FOUND'
  // after a run
  | 'DELIVERED'
  | 'FAILED';

export type TrackingDeliveryRow = {
  code: string;
  state: TrackingDeliveryState;
  orders: {
    _id: string;
    customer: string;
    tribe: string;
    status: string;
    approvalStatus: string | null;
  }[];
  error?: string;
};

// Media ZIP limits: customer photos are a few MB; anything far beyond is not one.
const MEDIA_FETCH_TIMEOUT_MS = 15_000;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

// Approved WhatsApp templates that tell a customer where their parcel is.
// Overridable by env so a re-approved template can be swapped without a deploy.
const DISPATCH_TEMPLATE_ID = '1057815553754091';
const DELIVERED_TEMPLATE_ID = '1419053503494614';
const RETURNED_TEMPLATE_ID = '1590261155917388';
// Sent once a customer's kit claim is in with its address ("we've received your
// address details for your <kit> from <brand>"). Named params, no header.
const CLAIM_RECEIVED_TEMPLATE_ID = '1066935259306839';

// The dispatch and delivered templates were approved with an IMAGE header, so
// those sends need one and Meta fetches it from a public URL at send time. The
// returned template has no header, and is sent without an image.
//
// Each notification has its own fixed picture, served by the frontend so the
// URL is stable and versioned with the site. Either can be overridden by env
// without a deploy; the platform mark remains the last resort.
const DISPATCH_IMAGE_URL = 'https://tribemerchandise.com/whatsapp-dispatch.jpg';
const DELIVERED_IMAGE_URL = 'https://tribemerchandise.com/whatsapp-delivered.jpg';
const DEFAULT_ORDER_IMAGE_URL = 'https://tribemerchandise.com/tribe-logo.png';

// Units on a requested order line (the DTO caps it; this floors junk to 1).
const lineQuantity = (item: any): number =>
  Math.max(1, Math.floor(Number(item?.quantity)) || 1);

// The size a stored order line was claimed in, so its stock moves in that size.
const sizeOf = (item: any): string | undefined =>
  item?.customizationType === 'SIZE' ? item.customizationValue : undefined;

// A phone number's last 10 digits — how orders, members and WhatsApp ids agree.
const phoneKeyOf = (v: unknown): string =>
  String(v ?? '')
    .replace(/\D/g, '')
    .slice(-10);

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Campaign.name) private campaignModel: Model<Campaign>,
    private productsService: ProductsService,
    private transactionsService: TransactionsService,
    private barcodesService: BarcodesService,
    private otpService: WhatsappOtpService,
    private whatsapp: WhatsappService,
    // Read-only: a kit-linked campaign's price can come from its kit.
    @InjectModel(TribeKit.name) private kitModel: Model<TribeKit>,
    // Links each order to its tribe member (coachId + phone).
    private members: TribeMembersService,
    // Read-only: a storefront order needs the tribe's storefront permission.
    private tribes: TribesService,
  ) {}

  /**
   * Keeps the order's tribe member in step after a write that can change it.
   * A member is derived data: a failure here is logged, never surfaced, so it
   * can't fail the order operation itself (the backfill script repairs drift).
   */
  private async recordMember(order: any): Promise<void> {
    try {
      await this.members.recordOrder(order);
    } catch (err: any) {
      this.logger.error(
        `Tribe member sync failed for order ${String(order?._id ?? order)}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * A campaign order must take exactly the campaign's contents: for each
   * campaign product, its lines (one per customization value) add up to the
   * product's quantity — 1 on lines saved before quantities existed — and
   * nothing else is in the order. A product deleted since the campaign was
   * made is the one exception: the claim form never shows it, so it may be
   * left out.
   */
  private async assertCampaignQuantities(campaign: any, rawItems: any[]) {
    const required = new Map<string, number>();
    for (const cp of campaign.products || []) {
      const id = String(cp.productId);
      required.set(id, (required.get(id) ?? 0) + (cp.quantity || 1));
    }
    const sent = new Map<string, number>();
    for (const item of rawItems) {
      const id = String(item.productId);
      sent.set(id, (sent.get(id) ?? 0) + lineQuantity(item));
    }
    const mismatch = () => new BadRequestException("Quantities don't match this campaign");
    for (const [id, qty] of sent) {
      if (required.get(id) !== qty) throw mismatch();
    }
    for (const id of required.keys()) {
      if (sent.has(id)) continue;
      const product: any = await this.productsService.findOne(id).catch(() => null);
      if (product && !product.isDeleted) throw mismatch();
    }
  }

  /**
   * The price a kit-linked campaign charges for one claim: its own override,
   * else the kit's price; null when neither is set (or it isn't linked), in
   * which case lines are priced one by one as before.
   */
  private async effectiveKitPrice(campaign: any): Promise<number | null> {
    if (!campaign?.kitId) return null;
    if (campaign.kitPrice != null) return roundMoney(campaign.kitPrice);
    const kit: any = await this.kitModel.findById(campaign.kitId).select('kitPrice').lean().exec();
    return kit?.kitPrice != null ? roundMoney(kit.kitPrice) : null;
  }

  // Public endpoint — NEVER trust client-supplied coachId / type / prices.
  // The campaign (or the products themselves) is the source of truth; this
  // prevents forged orders that mint commission to arbitrary tribes.
  //
  // Everything that can reject the order is checked before any stock moves;
  // the writes that follow (stock, save, commission) are undone together if
  // one of them fails. No Mongo transaction — dev runs a standalone mongod.
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
      await this.assertCampaignQuantities(campaign, rawItems);
    }

    const type: OrderType = campaign ? campaign.type : OrderType.STORE_SALE;
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
        ...(addr.alternatePhone ? { alternatePhone: addr.alternatePhone } : {}),
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

    // Pass 1 — validate and price every line. Nothing is written yet.
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
      // A PHOTO value is a URL the server later downloads (media ZIP), so it
      // must point at our own upload bucket and nowhere else.
      if (item.customizationType === 'PHOTO' && item.customizationValue &&
          !isAllowedMediaUrl(item.customizationValue)) {
        throw new BadRequestException('Upload the photo through the form before ordering');
      }

      const quantity = lineQuantity(item);
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

      itemsWithDetails.push({
        productId: product._id,
        quantity,
        retailPrice,
        baseCost: product.baseProductionCost,
        commission,
        // Weight for kit-price allocation below; not stored.
        productRetail: product.retailPrice || 0,
        ...(item.customizationType
          ? { customizationType: item.customizationType, customizationValue: item.customizationValue }
          : {}),
      });
    }

    if (!coachId) throw new BadRequestException('Could not resolve the tribe for this order');

    // A kit-linked store sale charges the kit price P for the whole claim, not
    // the sum of its lines. P (as per-unit prices) and the commission it leaves
    // (never negative) are spread over the lines by retail value, to the
    // paisa, so the lines add up to the totals — see allocateUnitPrices for
    // the one case a unit price can't land exactly.
    const kitPrice = type === OrderType.STORE_SALE ? await this.effectiveKitPrice(campaign) : null;
    if (kitPrice != null) {
      const retailValues = itemsWithDetails.map((l) => (l.productRetail || 0) * l.quantity);
      const quantities = itemsWithDetails.map((l) => l.quantity);
      totalAmount = kitPrice;
      totalCommission = Math.max(0, roundMoney(kitPrice - totalCost));
      const unitPrices = allocateUnitPrices(totalAmount, retailValues, quantities);
      const commissions = allocate(totalCommission, retailValues, quantities);
      itemsWithDetails.forEach((line, i) => {
        line.retailPrice = unitPrices[i];
        line.commission = commissions[i];
      });
    }
    for (const line of itemsWithDetails) delete line.productRetail;

    // Explicit build — do NOT spread client orderData (mass-assignment guard).
    const order = new this.orderModel({
      coachId,
      campaignId: orderData.campaignId,
      ...(orderData.termsAccepted ? { termsAcceptedAt: new Date() } : {}),
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
    // Schema validation up front too, so a bad document never costs stock.
    await order.validate();

    // A storefront order (no campaign) needs the tribe's storefront switched
    // on. Staff placing an order by hand are not held to it.
    if (!campaign && coachId && !opts.trusted) {
      const allowed = await this.tribes.permissionsOf(coachId);
      if (!allowed.storefront) {
        throw new BadRequestException('This store is not taking orders right now');
      }
    }

    // Pass 2 — the writes. Track each so a failure can put everything back.
    const decremented: { id: string; qty: number; size?: string }[] = [];
    let savedOrder: Order | null = null;
    try {
      // Stock never blocks an order or claim: it may go below zero, and that
      // shortfall is what the admin restocks. A sized item draws from its size.
      for (const item of itemsWithDetails) {
        const size = sizeOf(item);
        await this.productsService.decrementStock(String(item.productId), item.quantity, size);
        decremented.push({ id: String(item.productId), qty: item.quantity, size });
      }

      savedOrder = await order.save();

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
    } catch (err) {
      // Compensate: drop the half-made order and restore any stock taken.
      if (savedOrder) {
        await this.orderModel.deleteOne({ _id: savedOrder._id } as any).exec().catch(() => undefined);
      }
      for (const d of decremented) await this.productsService.incrementStock(d.id, d.qty, d.size);
      throw err;
    }

    // Increment campaign claims if applicable
    if (orderData.campaignId) {
      await this.campaignModel.findByIdAndUpdate(orderData.campaignId, {
        $inc: { claims: 1 }
      });
    }

    await this.recordMember(savedOrder);

    // The customer's own claim, with its address: confirm it on WhatsApp. Not for
    // staff-placed orders (CSV tool) or address-later claims — those confirm when
    // the customer fills the address in (attachAddressByPhone).
    if (isWelcomeKit && campaign && !opts.trusted && !addressPending) {
      void this.notifyClaimReceived(String(savedOrder._id));
    }
    return savedOrder;
  }

  /**
   * Whether a signed-in TRIBE caller owns the campaign it is submitting
   * against — part of deciding if it may skip the public-form checks.
   */
  async isCampaignOwnedBy(campaignId: string, coachId: string): Promise<boolean> {
    if (!isValidObjectId(campaignId) || !coachId) return false;
    const campaign = await this.campaignModel.findById(campaignId).select('coachId').lean().exec();
    return !!campaign && String(campaign.coachId) === String(coachId);
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
      // Kept when the incoming payload omits it — step 1 may have captured it.
      alternatePhone: incoming.alternatePhone || e.alternatePhone,
      email: incoming.email || e.email,
    };
  }

  /**
   * Public, after WhatsApp verification: has this number already claimed from
   * this campaign? The claim form warns the customer but still lets them
   * submit. Asking needs a proof token for the number, so it can't be used to
   * find out who has claimed.
   */
  async claimCheck(campaignId: string, phone: string, otpToken?: string) {
    const key = phoneKeyOf(phone);
    if (!otpToken || !this.otpService.checkProof(otpToken, key).ok) {
      throw new BadRequestException('Verify your WhatsApp number first');
    }
    if (!isValidObjectId(campaignId) || key.length !== 10) {
      return { alreadyClaimed: false, count: 0 };
    }
    const claims = await this.orderModel
      .find({
        campaignId,
        isDeleted: { $ne: true },
        approvalStatus: { $ne: ApprovalStatus.REJECTED },
      } as any)
      .select('shippingAddress.phone')
      .lean()
      .exec();
    const count = claims.filter(
      (o: any) => phoneKeyOf(o.shippingAddress?.phone) === key,
    ).length;
    return { alreadyClaimed: count > 0, count };
  }

  /**
   * Adds `priorClaims` to each campaign order: the same customer's earlier
   * claims on the same campaign (same tribe member, i.e. tribe + phone), not
   * deleted or rejected — what the "already claimed" alert lists. Returns
   * plain objects; used only on the way out of read endpoints.
   */
  async withPriorClaims(orders: any[]): Promise<any[]> {
    const plain = orders.map((o) => (o?.toObject ? o.toObject() : o));
    const claims = plain.filter((o) => o?.campaignId && o?.memberId);
    const keyOf = (o: any) => `${refIdOf(o.memberId)}|${refIdOf(o.campaignId)}`;
    const groups = new Map<string, any[]>();
    if (claims.length) {
      const siblings = await this.orderModel
        .find({
          memberId: { $in: [...new Set(claims.map((o) => refIdOf(o.memberId)))] },
          campaignId: { $in: [...new Set(claims.map((o) => refIdOf(o.campaignId)))] },
          isDeleted: { $ne: true },
          approvalStatus: { $ne: ApprovalStatus.REJECTED },
        } as any)
        .select('memberId campaignId createdAt status approvalStatus')
        .lean()
        .exec();
      for (const s of siblings as any[]) {
        const k = keyOf(s);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(s);
      }
    }
    const earlier = (a: any, b: any) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return ta < tb || (ta === tb && String(a._id) < String(b._id));
    };
    for (const o of plain) {
      if (!o) continue;
      o.priorClaims =
        o.campaignId && o.memberId
          ? (groups.get(keyOf(o)) ?? [])
              .filter((s) => String(s._id) !== String(o._id) && earlier(s, o))
              .sort((a, b) => (earlier(a, b) ? -1 : 1))
              .map((s) => ({
                _id: String(s._id),
                createdAt: s.createdAt,
                status: s.status,
                approvalStatus: s.approvalStatus ?? null,
              }))
          : [];
    }
    return plain;
  }

  /** `withPriorClaims` for a paginated result ({ data, total, ... }). */
  async withPriorClaimsPage<T extends { data: any[] }>(page: T): Promise<T> {
    return { ...page, data: await this.withPriorClaims(page.data) };
  }

  // Public: does an address-pending claim exist for this campaign + phone?
  // The name on the claim is only returned to a caller who has proven the
  // number over WhatsApp — otherwise this would map phone numbers to names.
  async findPendingClaim(campaignId: string, phone: string, otpToken?: string) {
    const cleanPhone = String(phone || '').trim();
    if (!isValidObjectId(campaignId) || !cleanPhone) return { found: false, count: 0 };
    const orders = await this.orderModel
      .find({ campaignId, addressPending: true, 'shippingAddress.phone': cleanPhone, isDeleted: { $ne: true } } as any)
      .select('shippingAddress.fullName createdAt')
      .sort({ createdAt: -1 })
      .exec();
    const verified = !!otpToken && this.otpService.checkProof(otpToken, cleanPhone).ok;
    return {
      found: orders.length > 0,
      count: orders.length,
      ...(verified && orders[0]?.shippingAddress?.fullName
        ? { fullName: orders[0].shippingAddress.fullName }
        : {}),
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

    // Optional, but if given it has to be a real number the courier can dial.
    const alternate = String(address?.alternatePhone ?? '').trim();
    if (alternate && !/^[6-9]\d{9}$/.test(alternate)) {
      throw new BadRequestException(
        'The alternate mobile number must be 10 digits starting with 6-9',
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
    opts: { trusted?: boolean; otpToken?: string; termsAccepted?: boolean } = {},
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
      if (opts.termsAccepted) order.termsAcceptedAt = new Date();
      order.addressPending = false;
      order.markModified('shippingAddress');
      await order.save();
      await this.recordMember(order);
    }
    // One confirmation per submission, even when it completes several claims
    // (same campaign + phone = same kit). Bulk uploads by staff don't message.
    if (!opts.trusted) void this.notifyClaimReceived(String(orders[0]._id));
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
    const saved = await order.save();
    await this.recordMember(saved);
    return saved;
  }

  // Admin: SOFT-delete an order — hidden from all lists/pipeline, recoverable via
  // restore. Frees stock while it is still on the shelf (NEW/PACKED — a
  // dispatched parcel has left, a returned one was restocked when it came back,
  // a cancelled one was restocked when cancelled) and reverses its commission.
  async deleteOrder(id: string): Promise<void> {
    // Atomic flip, returning the order as it was: of two concurrent deletes
    // only one matches, so stock and ledger move once.
    const order = await this.orderModel
      .findOneAndUpdate(
        { _id: id, isDeleted: { $ne: true } } as any,
        { $set: { isDeleted: true, deletedAt: new Date() } },
        { new: false },
      )
      .exec();
    if (!order) {
      if (!(await this.orderModel.exists({ _id: id } as any))) {
        throw new NotFoundException(`Order with ID ${id} not found`);
      }
      return; // already deleted
    }
    // The member's order count and dates leave this order out from now on.
    await this.recordMember(order);

    if (ON_SHELF.includes(order.status)) {
      await this.moveItemsStock(order.items, +1);
    }
    // Free the barcode back to the pool only while the order is still in the
    // "Ready to Ship" (PACKED) stage — it hasn't physically shipped yet. Once
    // DISPATCHED/DELIVERED the barcode is on a real parcel and must never be reused.
    if (order.status === OrderStatus.PACKED) {
      await this.barcodesService.releaseFromOrder(id);
      await this.orderModel
        .updateOne({ _id: id } as any, { $unset: { trackingNumber: 1 }, $set: { barcodePending: false } })
        .exec();
    }
    await this.transactionsService.reverseByOrder(id, 'Order deleted');
  }

  // Admin: restore a soft-deleted order. Re-takes stock where delete freed it
  // and re-creates its commission ledger entry where applicable.
  async restoreOrder(id: string): Promise<Order> {
    const order = await this.orderModel
      .findOneAndUpdate(
        { _id: id, isDeleted: true } as any,
        { $set: { isDeleted: false }, $unset: { deletedAt: 1 } },
        { new: false },
      )
      .exec();
    if (!order) return this.findOne(id); // not deleted (or 404s)
    await this.recordMember(order);

    if (ON_SHELF.includes(order.status)) {
      await this.moveItemsStock(order.items, -1);
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
      const bc = type ? await this.barcodesService.assignToOrder(id, type) : null;
      await this.orderModel
        .updateOne(
          { _id: id } as any,
          bc
            ? { $set: { trackingNumber: bc.code, barcodePending: false } }
            : { $set: { barcodePending: true } },
        )
        .exec();
    }
    return this.findOne(id);
  }

  /** Moves each line's stock back (+1) onto the shelf or off it again (-1). */
  private async moveItemsStock(items: any[], direction: 1 | -1): Promise<void> {
    for (const item of items || []) {
      const pid = (item.productId as any)?._id || item.productId;
      if (!pid) continue;
      if (direction > 0) await this.productsService.incrementStock(String(pid), item.quantity, sizeOf(item));
      else await this.productsService.decrementStock(String(pid), item.quantity, sizeOf(item));
    }
  }

  /**
   * Admin: rejected claims, paginated and searchable.
   *
   * Order listings exclude rejected claims (see NOT_REJECTED) so the pipeline
   * only holds work that still matters — this is the one place they surface,
   * for looking one up or checking a decision.
   */
  async findRejected(
    options: {
      coachId?: string;
      campaignId?: string;
      page?: number;
      limit?: number;
      search?: string;
    } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 20);
    const skip = (page - 1) * limit;

    const filter: any = {
      approvalStatus: ApprovalStatus.REJECTED,
      isDeleted: { $ne: true },
    };
    const coaches = coachIdsFilter(options.coachId);
    if (coaches) filter.coachId = coaches;
    andCampaignFilter(filter, options.campaignId);

    const search = options.search?.trim();
    if (search) {
      // Escape regex special chars so user input is treated literally.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        { 'shippingAddress.state': regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .populate('coachId')
        .populate('campaignId', 'name type')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  /**
   * Logs a parcel that came back, found by the tracking number on it — which is
   * what an admin has in hand (typed, or scanned off the label).
   *
   * Stock goes back on the shelf: the goods are physically returned. Commission
   * is deliberately left alone — reversing a tribe's earnings is a money
   * decision, not a side effect of scanning a barcode.
   */
  async markReturned(
    trackingNumber: string,
    note?: string,
  ): Promise<Order> {
    const code = (trackingNumber || '').trim();
    if (!code) throw new BadRequestException('Enter or scan a tracking number');

    // Atomic transition: only a dispatched/delivered parcel becomes RETURNED,
    // so scanning the same label twice (or two people at once) restocks once.
    const now = new Date();
    const order = await this.orderModel
      .findOneAndUpdate(
        {
          trackingNumber: code,
          isDeleted: { $ne: true },
          status: { $in: [OrderStatus.DISPATCHED, OrderStatus.DELIVERED] },
        } as any,
        {
          $set: { status: OrderStatus.RETURNED, returnedAt: now, ...(note ? { returnNote: note } : {}) },
          $push: { statusHistory: { status: OrderStatus.RETURNED, at: now, note } },
        },
        { new: true },
      )
      .exec();
    if (!order) {
      const existing = await this.orderModel
        .findOne({ trackingNumber: code, isDeleted: { $ne: true } } as any)
        .select('status')
        .exec();
      if (!existing) {
        throw new NotFoundException(`No order found with tracking number ${code}`);
      }
      if (existing.status === OrderStatus.RETURNED) {
        throw new BadRequestException('That parcel is already logged as returned');
      }
      // A parcel can only come back if it went out.
      throw new BadRequestException(
        `This order is ${existing.status.toLowerCase()} — only a dispatched or delivered parcel can be returned`,
      );
    }

    // The goods are physically back on the shelf.
    await this.moveItemsStock(order.items, +1);

    // Ask the customer to confirm their address, since an undelivered parcel is
    // usually a bad one. Deliberately not awaited, and it never throws: logging
    // a return at the packing bench must not fail because WhatsApp is slow.
    void this.notifyCustomerOfStatus(String(order._id), OrderStatus.RETURNED);
    return order;
  }

  /** Admin: returned parcels, paginated and searchable (tracking number included). */
  async findReturned(
    options: {
      coachId?: string;
      campaignId?: string;
      page?: number;
      limit?: number;
      search?: string;
    } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 20);
    const skip = (page - 1) * limit;

    const filter: any = {
      status: OrderStatus.RETURNED,
      isDeleted: { $ne: true },
    };
    const coaches = coachIdsFilter(options.coachId);
    if (coaches) filter.coachId = coaches;
    andCampaignFilter(filter, options.campaignId);

    const search = options.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        { trackingNumber: regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ returnedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('items.productId')
        .populate('coachId')
        .populate('campaignId', 'name type')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  /**
   * Sends a returned parcel out again: a fresh NEW order carrying the same items
   * and (possibly corrected) address, linked to the original in both directions.
   *
   * A new order rather than a status rewind, because the first attempt really
   * happened — it consumed a barcode and a postage charge, and the history of
   * both should survive. For the same reason the original keeps the address it
   * was actually sent to: a corrected address applies to the replacement only.
   */
  async reorderReturned(id: string, address?: any): Promise<Order> {
    // Claim the original first, atomically: of two concurrent re-sends only
    // one links a replacement, so the stock is taken once.
    const replacementId = new Types.ObjectId();
    const original = await this.orderModel
      .findOneAndUpdate(
        { _id: id, status: OrderStatus.RETURNED, reorderedTo: null, isDeleted: { $ne: true } } as any,
        { $set: { reorderedTo: replacementId } },
        { new: false },
      )
      .exec();
    if (!original) {
      const existing = await this.orderModel.findById(id).select('status reorderedTo isDeleted').exec();
      if (!existing || existing.isDeleted) throw new NotFoundException(`Order with ID ${id} not found`);
      if (existing.status !== OrderStatus.RETURNED) {
        throw new BadRequestException('Only a returned order can be sent again');
      }
      throw new BadRequestException('This return has already been sent again');
    }

    const now = new Date();
    const replacement = new this.orderModel({
      _id: replacementId,
      coachId: original.coachId,
      campaignId: original.campaignId,
      type: original.type,
      status: OrderStatus.NEW,
      // Already approved once — a re-send shouldn't queue for approval again.
      approvalStatus: original.approvalStatus,
      items: original.items,
      totalAmount: original.totalAmount,
      totalCost: original.totalCost,
      // No second commission: the ledger entry from the first order still stands.
      totalCommission: 0,
      // Corrected fields win; anything omitted falls back to the original.
      shippingAddress: address
        ? this.mergeAddress(original.shippingAddress, address)
        : original.shippingAddress,
      deliveryType: original.deliveryType,
      reorderedFrom: original._id,
      statusHistory: [{ status: OrderStatus.NEW, at: now, note: 'Re-sent after return' }],
    });

    // Stock was returned when the parcel came back; the replacement consumes it.
    let stockTaken = false;
    let saved: Order;
    try {
      await replacement.validate();
      await this.moveItemsStock(original.items, -1);
      stockTaken = true;
      saved = await replacement.save();
    } catch (err) {
      // Undo the claim so the return can be re-sent once the problem is fixed.
      if (stockTaken) await this.moveItemsStock(original.items, +1);
      await this.orderModel
        .updateOne({ _id: id, reorderedTo: replacementId } as any, { $unset: { reorderedTo: 1 } })
        .exec();
      throw err;
    }
    await this.recordMember(saved);
    return saved;
  }

  // Admin: list soft-deleted orders (optionally scoped to a tribe).
  async findDeleted(
    coachId?: string | string[],
    campaignId?: string | string[],
  ): Promise<Order[]> {
    const filter: any = { isDeleted: true };
    const coaches = coachIdsFilter(coachId);
    if (coaches) filter.coachId = coaches;
    andCampaignFilter(filter, campaignId);
    return this.orderModel
      .find(filter)
      .sort({ deletedAt: -1 })
      .populate('items.productId')
      .populate('coachId')
      .populate('campaignId', 'name type packageWeight length breadth height')
      .exec();
  }

  /**
   * Downloads one media file, bounded in time and size. Redirects are refused
   * so an allowed URL can't bounce the server somewhere else.
   */
  private async fetchMedia(url: string): Promise<Buffer | null> {
    const resp = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) return null;
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MEDIA_MAX_BYTES) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MEDIA_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  // Admin: stream a ZIP of the customer-uploaded PHOTO media for the given orders.
  // Images are fetched server-side from their public URLs (no browser CORS issues).
  async streamMediaZip(orderIds: string[], res: Response): Promise<void> {
    const ids = (orderIds || [])
      .filter((id) => isValidObjectId(id))
      .slice(0, MAX_MEDIA_ORDERS);
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
        // Only our own bucket is ever fetched — older orders may hold anything.
        if (!isAllowedMediaUrl(item.customizationValue)) continue;
        try {
          const buf = await this.fetchMedia(String(item.customizationValue));
          if (!buf) continue;
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
    const now = new Date();
    const update: any = {
      $set: {
        approvalStatus: ApprovalStatus.APPROVED,
        approvedBy,
        approvedAt: now,
        ...(note ? { approvalNote: note } : {}),
      },
      $push: { statusHistory: { status: 'APPROVED', at: now, note } },
    };
    const options: { new: true; arrayFilters?: Record<string, unknown>[] } = { new: true };

    // If a selection was provided, mark items not in the list as unselected
    // (item is kept in the order, only its `selected` flag changes).
    if (Array.isArray(selectedItemIds)) {
      const selected = selectedItemIds
        .filter((i) => isValidObjectId(i))
        .map((i) => new Types.ObjectId(String(i)));
      update.$set['items.$[kept].selected'] = true;
      update.$set['items.$[dropped].selected'] = false;
      options.arrayFilters = [
        { 'kept._id': { $in: selected } },
        { 'dropped._id': { $nin: selected } },
      ];
    }

    // Atomic PENDING → APPROVED: a double click (or tribe and admin at once)
    // approves once, so commission is recorded once.
    const savedOrder = await this.orderModel
      .findOneAndUpdate(
        { _id: id, ...PENDING_KIT } as any,
        update,
        options,
      )
      .exec();
    if (!savedOrder) await this.explainNotPending(id);

    // Record commission transaction on approval if applicable
    if (savedOrder!.totalCommission > 0) {
      await this.transactionsService.create({
        coachId: savedOrder!.coachId as any,
        type: TransactionType.COMMISSION,
        amount: savedOrder!.totalCommission,
        orderId: savedOrder!._id as any,
        description: `Commission from Approved Kit Order #${savedOrder!._id.toString().slice(-6)}`,
      });
    }

    return savedOrder!;
  }

  async rejectOrder(id: string, rejectedBy: string, note?: string): Promise<Order> {
    const now = new Date();
    // Atomic PENDING → REJECTED, returning the order as it was, so stock is
    // restored exactly once. Only while it is still on the shelf.
    const before = await this.orderModel
      .findOneAndUpdate(
        { _id: id, ...PENDING_KIT, status: { $in: ON_SHELF } } as any,
        {
          $set: {
            approvalStatus: ApprovalStatus.REJECTED,
            approvedBy: rejectedBy,
            approvedAt: now,
            status: OrderStatus.CANCELLED,
            ...(note ? { approvalNote: note } : {}),
          },
          $push: { statusHistory: { status: 'REJECTED', at: now, note } },
        },
        { new: false },
      )
      .exec();
    if (!before) await this.explainNotPending(id);

    // Restore stock atomically.
    await this.moveItemsStock(before!.items, +1);
    // A pending claim packed by mistake still holds a barcode; free it.
    if (before!.status === OrderStatus.PACKED) {
      await this.barcodesService.releaseFromOrder(id);
      await this.orderModel
        .updateOne({ _id: id } as any, { $unset: { trackingNumber: 1 }, $set: { barcodePending: false } })
        .exec();
    }
    return this.findOne(id);
  }

  // Why an approve/reject precondition didn't match, as the right error.
  private async explainNotPending(id: string): Promise<never> {
    const order = await this.orderModel
      .findOne({ _id: id, isDeleted: { $ne: true } } as any)
      .select('type approvalStatus')
      .exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);
    if (order.type !== OrderType.WELCOME_KIT) throw new BadRequestException('Only Welcome Kit orders require approval');
    throw new BadRequestException('Order is not pending approval');
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
    return this.orderModel.find({ ...NOT_REJECTED, isDeleted: { $ne: true } } as any).sort({ createdAt: -1 }).populate('coachId').populate('items.productId').populate('campaignId', 'name type packageWeight length breadth height').exec();
  }

  async findByCoach(coachId: string): Promise<Order[]> {
    return this.orderModel.find({ ...NOT_REJECTED, coachId, isDeleted: { $ne: true } } as any).sort({ createdAt: -1 }).populate('items.productId').populate('campaignId', 'name type packageWeight length breadth height').exec();
  }

  async findByCoachPaginated(
    coachId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      campaignId?: string | string[];
    } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 10);
    const skip = (page - 1) * limit;

    const filter: any = { ...NOT_REJECTED, coachId, isDeleted: { $ne: true } };
    andCampaignFilter(filter, options.campaignId);

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
        .populate('campaignId', 'name type packageWeight length breadth height')
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

  // Same as findByCoachPaginated but across ALL coaches (admin Orders page),
  // or the ones `coachId` names — one id, or several comma-separated.
  async findAllPaginated(
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      coachId?: string | string[];
      campaignId?: string | string[];
    } = {},
  ): Promise<{
    data: Order[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 10);
    const skip = (page - 1) * limit;

    const filter: any = { ...NOT_REJECTED, isDeleted: { $ne: true } };
    const coaches = coachIdsFilter(options.coachId);
    if (coaches) filter.coachId = coaches;
    andCampaignFilter(filter, options.campaignId);
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
        .populate('campaignId', 'name type packageWeight length breadth height')
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

  /**
   * Admin "Duplicate orders": orders whose phone number is on more than one
   * order of the same tribe. Numbers match on their last 10 characters, so +91
   * and spacing don't split a customer. Rejected and deleted orders don't count.
   *
   * Tribe and campaign set where repeats are looked for; status and search only
   * pick rows from them — so a repeat whose other order is delivered still shows
   * under "New". Rows come back grouped: each number's orders together (newest
   * first), newest group first.
   */
  async findDuplicates(
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      coachId?: string | string[];
      campaignId?: string | string[];
    } = {},
  ): Promise<{
    data: Order[];
    total: number;
    groups: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 20);

    const scope: any = { ...NOT_REJECTED, isDeleted: { $ne: true } };
    const coaches = coachIdsFilter(options.coachId);
    if (coaches) scope.coachId = coaches;
    andCampaignFilter(scope, options.campaignId);

    // Aggregation doesn't cast like find(): turn id strings into ObjectIds first.
    const match = this.orderModel.find().cast(this.orderModel, scope);
    const phone = { $trim: { input: { $ifNull: ['$shippingAddress.phone', ''] } } };
    const grouped: { ids: Types.ObjectId[] }[] = await this.orderModel
      .aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $project: { coachId: 1, createdAt: 1, p: phone } },
        { $match: { p: { $ne: '' } } },
        {
          $group: {
            _id: {
              coachId: '$coachId',
              phone: {
                $substrCP: ['$p', { $max: [{ $subtract: [{ $strLenCP: '$p' }, 10] }, 0] }, 10],
              },
            },
            ids: { $push: '$_id' },
            n: { $sum: 1 },
            latest: { $max: '$createdAt' },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $sort: { latest: -1, '_id.phone': 1 } },
        { $project: { ids: 1 } },
      ])
      .exec();
    let groupsOf = grouped.map((g) => g.ids.map(String));

    // Status / search on top: keep the grouping, drop rows they exclude.
    const narrow: any = {};
    if (options.status) {
      narrow.status = options.status;
      if (options.status === OrderStatus.NEW) {
        narrow.approvalStatus = { $ne: ApprovalStatus.PENDING };
      } else if (options.status === 'PENDING') {
        // "Pending approval" is an approval state, not an order status.
        delete narrow.status;
        narrow.approvalStatus = ApprovalStatus.PENDING;
      }
    }
    const search = options.search?.trim();
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      narrow.$or = [
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        { trackingNumber: regex },
      ];
    }
    if (Object.keys(narrow).length && groupsOf.length) {
      const keep = new Set(
        (
          await this.orderModel
            .find({ ...narrow, _id: { $in: groupsOf.flat() } } as any)
            .select('_id')
            .lean()
            .exec()
        ).map((o: any) => String(o._id)),
      );
      groupsOf = groupsOf.map((g) => g.filter((id) => keep.has(id))).filter((g) => g.length);
    }

    const ids = groupsOf.flat();
    const total = ids.length;
    const pageIds = ids.slice((page - 1) * limit, page * limit);
    const docs = pageIds.length
      ? await this.orderModel
          .find({ _id: { $in: pageIds } } as any)
          .populate('items.productId')
          .populate({ path: 'coachId', populate: { path: 'userId', select: 'name email' } })
          .populate('campaignId', 'name type packageWeight length breadth height')
          .exec()
      : [];
    const byId = new Map(docs.map((d: any) => [String(d._id), d]));
    const data = pageIds.map((id) => byId.get(id)).filter(Boolean) as Order[];
    return {
      data,
      total,
      groups: groupsOf.length,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderModel
      .findOne({ _id: id, isDeleted: { $ne: true } } as any)
      .populate('items.productId')
      .exec();
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
    // Admin "Mark Delivered" tool only: a New / Ready to Ship order may go
    // straight to Delivered (the parcel is known to have arrived).
    opts: { skipDispatch?: boolean } = {},
  ): Promise<Order> {
    const now = new Date();
    const order = await this.orderModel
      .findOne({ _id: id, isDeleted: { $ne: true } } as any)
      .exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);

    // Validate the move before anything is claimed or changed. Going backwards
    // is revert-status's job; a return is logged with POST /orders/returned.
    const previousStatus = order.status;
    const skippingDispatch =
      !!opts.skipDispatch &&
      status === OrderStatus.DELIVERED &&
      (previousStatus === OrderStatus.NEW || previousStatus === OrderStatus.PACKED);
    if (
      !skippingDispatch &&
      !(ALLOWED_TRANSITIONS[previousStatus] || []).includes(status)
    ) {
      throw new BadRequestException(
        `A ${previousStatus.toLowerCase()} order can't be moved to ${status.toLowerCase()}`,
      );
    }
    if (
      order.approvalStatus === ApprovalStatus.PENDING &&
      status !== OrderStatus.CANCELLED
    ) {
      throw new BadRequestException('Approve this claim before it can be fulfilled');
    }

    const $set: any = { status };
    const $unset: any = {};
    const explicitTracking = trackingNumber?.trim();

    // Auto-assign a postal tracking barcode when an order is packed / made ready to
    // ship (the "Pack" action moves NEW → PACKED). Idempotent (keeps an already-
    // assigned barcode) and atomic (never shared across orders). Skipped when an
    // explicit tracking number is supplied. If no barcode of the order's delivery
    // type is available, the order still advances but is flagged `barcodePending`
    // so it can be assigned once more are uploaded.
    let claimed: { _id: any; code: string } | null = null;
    if (status === OrderStatus.PACKED && !explicitTracking) {
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
        $set.deliveryType = deliveryType;
      }
      const hadBarcode = !!(await this.barcodesService.findByOrder(id));
      const barcode: any = await this.barcodesService.assignToOrder(id, resolvedType);
      if (barcode) {
        $set.trackingNumber = barcode.code;
        $set.barcodePending = false;
        if (!hadBarcode) claimed = barcode;
      } else {
        $set.barcodePending = true;
      }
    }

    if (status === OrderStatus.DELIVERED) $set.deliveredAt = now;
    // An explicit tracking number (e.g. entered at dispatch) overrides the barcode.
    if (explicitTracking) $set.trackingNumber = explicitTracking;

    // Cancelling before dispatch frees what the order was holding.
    if (status === OrderStatus.CANCELLED && previousStatus === OrderStatus.PACKED) {
      $unset.trackingNumber = 1;
      $set.barcodePending = false;
    }

    // Conditional on the status we validated against: a concurrent change
    // makes this miss instead of applying a transition from a stale state.
    const saved = await this.orderModel
      .findOneAndUpdate(
        { _id: id, status: previousStatus, isDeleted: { $ne: true } } as any,
        {
          $set,
          ...(Object.keys($unset).length ? { $unset } : {}),
          // Skipping dispatch still records it, so reports that count shipped
          // parcels (analytics, restock pace) see this one.
          $push: {
            statusHistory: skippingDispatch
              ? {
                  $each: [
                    { status: OrderStatus.DISPATCHED, at: now, note: 'Marked delivered from barcode list' },
                    { status, at: now, note: 'Marked delivered from barcode list' },
                  ],
                }
              : { status, at: now },
          },
        },
        { new: true },
      )
      .exec();
    if (!saved) {
      // Give back a barcode claimed for a transition that didn't happen.
      if (claimed) await this.barcodesService.releaseOne(claimed._id);
      throw new ConflictException('This order changed while you were updating it — refresh and try again');
    }

    if (status === OrderStatus.CANCELLED && previousStatus !== OrderStatus.CANCELLED) {
      // NEW/PACKED only (see ALLOWED_TRANSITIONS), so the stock is still out.
      await this.moveItemsStock(saved.items, +1);
      if (previousStatus === OrderStatus.PACKED) {
        await this.barcodesService.releaseFromOrder(id);
      }
      // A cancelled order earns nothing: take back any commission it credited
      // (store sales at creation, kits at approval). Idempotent per order.
      await this.transactionsService.reverseByOrder(id, 'Order cancelled');
    }

    // Only on a real transition — re-saving an already-dispatched order must not
    // message the customer twice. Deliberately not awaited: a slow Graph call
    // shouldn't hold up the admin's status change, and bulk dispatch would
    // otherwise serialise one network round trip per order.
    if (status !== previousStatus) {
      void this.notifyCustomerOfStatus(id, status);
    }
    return saved;
  }

  /**
   * Tells the customer their parcel has shipped, arrived, or come back to us,
   * over WhatsApp.
   *
   * Never throws: a messaging failure must not look like a failed status
   * update. Templates are allowed outside the 24-hour window, which is the
   * whole reason these are templates and not free-form messages.
   */
  private async notifyCustomerOfStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    const templateId =
      status === OrderStatus.DISPATCHED
        ? process.env.WHATSAPP_DISPATCH_TEMPLATE_ID || DISPATCH_TEMPLATE_ID
        : status === OrderStatus.DELIVERED
          ? process.env.WHATSAPP_DELIVERED_TEMPLATE_ID || DELIVERED_TEMPLATE_ID
          : status === OrderStatus.RETURNED
            ? process.env.WHATSAPP_RETURNED_TEMPLATE_ID || RETURNED_TEMPLATE_ID
            : null;
    if (!templateId) return;

    if (!this.whatsapp.canSend) {
      this.logger.warn(
        `WhatsApp is not configured — skipping the ${status} notification for ${orderId}`,
      );
      return;
    }

    try {
      const order: any = await this.orderModel
        .findById(orderId)
        .populate('coachId')
        .populate('campaignId', 'name')
        .populate('items.productId', 'name')
        .exec();

      const phone = order?.shippingAddress?.phone;
      if (!phone) return;

      const coach = order.coachId || {};
      const kitName =
        order.campaignId?.name ||
        order.items?.[0]?.productId?.name ||
        'order';

      // Only the dispatch and delivered templates carry a media header. The
      // returned one has no header at all, and offering an image for a template
      // that declares none is pointless — `sendTemplateByIdTo` drops it anyway.
      const headerImageUrl =
        status === OrderStatus.DISPATCHED
          ? process.env.WHATSAPP_DISPATCH_IMAGE_URL || DISPATCH_IMAGE_URL
          : status === OrderStatus.DELIVERED
            ? process.env.WHATSAPP_DELIVERED_IMAGE_URL ||
              DELIVERED_IMAGE_URL ||
              DEFAULT_ORDER_IMAGE_URL
            : undefined;

      await this.whatsapp.sendTemplateByIdTo(
        phone,
        templateId,
        {
          // Names arrive from the public form in whatever case was typed, and
          // "Hi RAVI KUMAR" reads as shouting. The fallback stays lowercase
          // because it sits mid-sentence ("Hi there").
          customer_name:
            titleCaseName(order.shippingAddress?.fullName) || 'there',
          client_brand: coach.brand || coach.name || 'Tribe Merchandise',
          kit_name: kitName,
          // Meta rejects an empty parameter, so never send a blank tracking id.
          tracking_id: order.trackingNumber || 'Shared soon',
        },
        { headerImageUrl },
      );
      this.logger.log(`Sent the ${status} WhatsApp update for order ${orderId}`);
    } catch (err) {
      this.logger.error(
        `Could not send the ${status} WhatsApp update for order ${orderId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Admin "Mark delivered" tool, step 1: what each pasted barcode / tracking
   * number points at, and whether it can be marked delivered. Read-only.
   *
   *   READY             one New / Ready to Ship / Dispatched order — will be marked delivered
   *   ALREADY_DELIVERED nothing to do
   *   CLOSED            returned or cancelled — left alone
   *   AWAITING_APPROVAL a claim not yet approved
   *   MULTIPLE          the code is on more than one order — left alone
   *   NOT_FOUND         no (non-deleted) order carries it
   */
  async previewDeliverByTracking(rawCodes: string[]): Promise<TrackingDeliveryRow[]> {
    const codes = uniqueCodes(rawCodes);
    if (codes.length > MAX_TRACKING_CODES) {
      throw new BadRequestException(
        `Up to ${MAX_TRACKING_CODES} different codes at a time — split the list`,
      );
    }
    if (!codes.length) return [];
    // Barcodes are stored uppercase; a hand-typed tracking number is stored as
    // typed (trimmed). Exact $in on both spellings keeps the trackingNumber index.
    const candidates = [
      ...new Set([...codes, ...rawCodes.map((r) => String(r ?? '').trim()).filter(Boolean)]),
    ];
    const orders: any[] = await this.orderModel
      .find({ isDeleted: { $ne: true }, trackingNumber: { $in: candidates } } as any)
      .select('trackingNumber status approvalStatus shippingAddress.fullName coachId type')
      .populate('coachId', 'brand name')
      .lean()
      .exec();

    const byCode = new Map<string, any[]>();
    for (const o of orders) {
      const key = String(o.trackingNumber ?? '').trim().toUpperCase();
      const list = byCode.get(key) ?? [];
      if (!list.some((x) => String(x._id) === String(o._id))) list.push(o);
      byCode.set(key, list);
    }

    return codes.map((code) => {
      const matches = byCode.get(code) ?? [];
      if (matches.length === 0) return { code, state: 'NOT_FOUND', orders: [] };
      const summary = matches.map((o) => ({
        _id: String(o._id),
        customer: o.shippingAddress?.fullName ?? '',
        tribe: o.coachId?.brand || o.coachId?.name || '',
        status: o.status,
        approvalStatus: o.approvalStatus ?? null,
      }));
      if (matches.length > 1) return { code, state: 'MULTIPLE', orders: summary };
      const o = matches[0];
      const state: TrackingDeliveryState =
        o.status === OrderStatus.DELIVERED
          ? 'ALREADY_DELIVERED'
          : o.approvalStatus === ApprovalStatus.PENDING
            ? 'AWAITING_APPROVAL'
            : o.status === OrderStatus.RETURNED || o.status === OrderStatus.CANCELLED
              ? 'CLOSED'
              : 'READY';
      return { code, state, orders: summary };
    });
  }

  /**
   * Step 2: marks every READY code's order delivered, through updateStatus — so
   * status history and the customer's "delivered" WhatsApp are exactly as when
   * the admin moves the card — except that New / Ready to Ship orders may skip
   * Dispatched (`skipDispatch`). Codes in any other state are reported, not
   * touched. One failure doesn't stop the rest.
   */
  async deliverByTracking(rawCodes: string[]): Promise<TrackingDeliveryRow[]> {
    const rows = await this.previewDeliverByTracking(rawCodes);
    for (const row of rows) {
      if (row.state !== 'READY') continue;
      try {
        await this.updateStatus(row.orders[0]._id, OrderStatus.DELIVERED, undefined, undefined, {
          skipDispatch: true,
        });
        row.state = 'DELIVERED';
        row.orders[0].status = OrderStatus.DELIVERED;
      } catch (err) {
        row.state = 'FAILED';
        row.error = (err as Error).message;
      }
    }
    const done = rows.filter((r) => r.state === 'DELIVERED').length;
    this.logger.log(`Mark delivered by tracking: ${done} of ${rows.length} codes delivered`);
    return rows;
  }

  /**
   * Confirms a kit claim to the customer over WhatsApp once its address is in.
   * Never throws and isn't awaited by callers: the claim has already been saved,
   * and a messaging failure must not look like a failed claim.
   */
  private async notifyClaimReceived(orderId: string): Promise<void> {
    if (!this.whatsapp.canSend) {
      this.logger.warn(
        `WhatsApp is not configured — skipping the claim confirmation for ${orderId}`,
      );
      return;
    }
    try {
      const order: any = await this.orderModel
        .findById(orderId)
        .populate('coachId')
        .populate('campaignId', 'name')
        .populate('items.productId', 'name')
        .exec();
      const phone = order?.shippingAddress?.phone;
      if (!phone) return;
      const coach = order.coachId || {};
      await this.whatsapp.sendTemplateByIdTo(
        phone,
        process.env.WHATSAPP_CLAIM_TEMPLATE_ID?.trim() || CLAIM_RECEIVED_TEMPLATE_ID,
        {
          // Same values and fallbacks as the dispatch/delivered updates.
          customer_name: titleCaseName(order.shippingAddress?.fullName) || 'there',
          kit_name:
            order.campaignId?.name || order.items?.[0]?.productId?.name || 'kit',
          client_brand: coach.brand || coach.name || 'Tribe Merchandise',
        },
      );
      this.logger.log(`Sent the claim confirmation WhatsApp for order ${orderId}`);
    } catch (err) {
      this.logger.error(
        `Could not send the claim confirmation WhatsApp for order ${orderId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Moves an order back one stage on the board, for a status clicked by
   * mistake. Only before anything ships:
   *
   *   Ready to Ship → New
   *   New → Approval Pending  (welcome kits that went through approval)
   *
   * A dispatched or delivered parcel is physically gone, so there is nothing to
   * take back — those are corrected by logging a return, not by rewinding.
   *
   * Deliberately NOT routed through updateStatus: that fires the customer's
   * WhatsApp notification, and undoing a misclick must not message anyone.
   */
  async revertStatus(id: string, performedBy?: string): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: id, isDeleted: { $ne: true } } as any).exec();
    if (!order) throw new NotFoundException(`Order with ID ${id} not found`);

    const now = new Date();

    // New → back into the approval queue. Only welcome kits reach New by being
    // approved; a store sale has nothing before it.
    if (
      order.status === OrderStatus.NEW &&
      order.approvalStatus === ApprovalStatus.APPROVED
    ) {
      order.approvalStatus = ApprovalStatus.PENDING;
      order.approvedAt = undefined as any;
      order.approvedBy = undefined as any;
      // Approval created the commission entry; un-approving must reverse it or
      // re-approving pays the tribe twice.
      await this.transactionsService.reverseByOrder(id, 'Approval undone');

      if (!order.statusHistory) order.statusHistory = [] as any;
      order.statusHistory.push({
        status: 'PENDING_APPROVAL',
        at: now,
        note: 'Reverted from New — returned to approval',
        by: performedBy as any,
      } as any);
      this.logger.log(`Order ${id} reverted from New to Approval Pending`);
      return order.save();
    }

    // Ready to Ship → New. The barcode stays attached: it may already be on a
    // printed label, and re-packing reuses the same one rather than burning a
    // second from the pool.
    if (order.status === OrderStatus.PACKED) {
      order.status = OrderStatus.NEW;
      if (!order.statusHistory) order.statusHistory = [] as any;
      order.statusHistory.push({
        status: OrderStatus.NEW,
        at: now,
        note: 'Reverted from Ready to Ship',
        by: performedBy as any,
      } as any);
      this.logger.log(`Order ${id} reverted from Ready to Ship to New`);
      return order.save();
    }

    throw new BadRequestException(
      order.status === OrderStatus.DISPATCHED || order.status === OrderStatus.DELIVERED
        ? 'This parcel has already shipped — log a return instead of moving it back'
        : `A ${order.status.toLowerCase()} order has no earlier stage to move back to`,
    );
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

