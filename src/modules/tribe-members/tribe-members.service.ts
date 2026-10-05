import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { TribeMember } from '../../schemas/tribe-member.schema';
import { Order } from '../../schemas/order.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { resolvePermissions } from '../../common/tribe-permissions';
import { pageSizeOf } from '../../common/utils/pagination.util';
import { coachIdsFilter } from '../../common/utils/coach-ids.util';
import {
  buildMemberFields,
  memberUpdate,
  normalizePhone,
  sameMemberFields,
} from './member-fields';

/** What one recordOrder call did — the backfill script tallies these. */
export interface RecordOrderResult {
  memberId: string;
  /** A new member was inserted for this (tribe, phone). */
  created: boolean;
  /** order.memberId was set or changed. */
  linked: boolean;
  /** The member's stored fields changed. */
  updated: boolean;
}

export type SyncOutcome = 'unchanged' | 'updated' | 'deleted' | 'gone';

// Optimistic-concurrency retries for a member being synced by several orders at once.
const SYNC_ATTEMPTS = 5;

// The populated tribe a member carries in every response.
const TRIBE_POPULATE = {
  path: 'coachId',
  select: 'username brand name userId',
  populate: { path: 'userId', select: 'name' },
};

@Injectable()
export class TribeMembersService {
  private readonly logger = new Logger(TribeMembersService.name);

  constructor(
    @InjectModel(TribeMember.name) private memberModel: Model<TribeMember>,
    // Read, plus $set memberId — this module never imports OrdersModule.
    @InjectModel(Order.name) private orderModel: Model<Order>,
    // Read only: which tribe a signed-in TRIBE user owns.
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
  ) {}

  /**
   * The tribe a TRIBE user owns — 404 if their account has none, 403 if an
   * admin hasn't switched on the Tribe Members permission for it.
   */
  async tribeIdForUser(userId: string): Promise<string> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id permissions')
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');
    if (!resolvePermissions((tribe as any).permissions).members) {
      throw new ForbiddenException(
        'Tribe Members is not enabled for your tribe. Contact the Tribe Merchandise team.',
      );
    }
    return String(tribe._id);
  }

  // ---- Keeping members in sync with orders ----

  /**
   * Links an order to its member — creating the member on its first order —
   * and recomputes that member from all of its linked orders. Idempotent, so
   * it is called after every order write that can change a member (create,
   * address attach/edit, re-send, delete, restore). Re-reads the order, so
   * pass the document or just its id.
   *
   * If the order's phone changed and it now belongs to another member, the
   * previous member is recomputed too (and removed once it has no orders).
   * Returns null when the order is gone or carries no phone.
   */
  async recordOrder(orderOrId: any): Promise<RecordOrderResult | null> {
    const id = orderOrId?._id ?? orderOrId;
    if (!id || !isValidObjectId(id)) return null;

    // A second pass only when the member vanished between upsert and sync.
    for (let attempt = 0; attempt < 2; attempt++) {
      const order: any = await this.orderModel
        .findById(id)
        .select('coachId shippingAddress.phone memberId')
        .lean()
        .exec();
      if (!order) return null;
      const phone = normalizePhone(order.shippingAddress?.phone);
      if (!phone || !order.coachId) {
        this.logger.warn(
          `Order ${String(id)} has no tribe or phone; not linked to a member`,
        );
        return null;
      }

      const { member, created } = await this.upsertMember(order.coachId, phone);
      const memberId = member._id;
      const previous = order.memberId ?? null;
      const linked = !previous || String(previous) !== String(memberId);
      if (linked) {
        // Only memberId changes — linking isn't an edit, so updatedAt stays.
        await this.orderModel
          .updateOne(
            { _id: id } as any,
            { $set: { memberId } },
            { timestamps: false },
          )
          .exec();
      }

      const outcome = await this.syncMember(memberId);
      if (outcome === 'gone') continue;
      if (previous && linked) await this.syncMember(previous);
      return {
        memberId: String(memberId),
        created,
        linked,
        updated: outcome === 'updated',
      };
    }
    this.logger.warn(
      `Order ${String(id)}: member kept disappearing; not linked`,
    );
    return null;
  }

  /**
   * Finds or creates the member for (tribe, phone) without a read-then-insert
   * race: an upsert on the unique { coachId, phone } index. Two concurrent
   * upserts can both miss and one gets E11000 — that one re-reads the winner's.
   * The existing-member read first keeps re-runs write-free.
   */
  async upsertMember(
    coachId: any,
    phone: string,
  ): Promise<{ member: any; created: boolean }> {
    const filter: any = { coachId, phone };
    const existing = await this.memberModel.findOne(filter).lean().exec();
    if (existing) return { member: existing, created: false };
    try {
      const now = new Date();
      const res: any = await this.memberModel
        .findOneAndUpdate(
          filter,
          {
            $setOnInsert: {
              name: '',
              addresses: [],
              orderCount: 0,
              createdAt: now,
              updatedAt: now,
              __v: 0,
            },
          },
          {
            upsert: true,
            returnDocument: 'after',
            includeResultMetadata: true,
            // Set by hand above, so a no-op match never bumps updatedAt.
            timestamps: false,
          },
        )
        .lean()
        .exec();
      return {
        member: res.value,
        created: !res.lastErrorObject?.updatedExisting,
      };
    } catch (err: any) {
      if (err?.code === 11000) {
        const winner = await this.memberModel.findOne(filter).lean().exec();
        if (winner) return { member: winner, created: false };
      }
      throw err;
    }
  }

  /**
   * Recomputes a member from the orders linked to it and writes the result if
   * it changed. The write is conditional on the member's version (`__v`), so
   * when two orders sync the same member at once, the one that read an older
   * picture retries instead of overwriting the newer one. A member with no
   * linked orders left is removed.
   */
  async syncMember(memberId: any): Promise<SyncOutcome> {
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      const member: any = await this.memberModel
        .findById(memberId)
        .lean()
        .exec();
      if (!member) return 'gone';
      const version =
        member.__v == null ? { __v: { $exists: false } } : { __v: member.__v };

      const orders = await this.orderModel
        .find({ memberId } as any)
        .select('shippingAddress createdAt isDeleted addressPending')
        .sort({ createdAt: 1, _id: 1 })
        .lean()
        .exec();

      if (!orders.length) {
        const res = await this.memberModel
          .deleteOne({ _id: memberId, ...version } as any)
          .exec();
        if (res.deletedCount) return 'deleted';
        continue;
      }

      const fields = buildMemberFields(orders as any[]);
      if (sameMemberFields(member, fields)) return 'unchanged';

      const update: any = memberUpdate(fields);
      update.$inc = { __v: 1 };
      const res = await this.memberModel
        .updateOne({ _id: memberId, ...version } as any, update)
        .exec();
      if (res.matchedCount) return 'updated';
    }
    throw new Error(
      `Tribe member ${String(memberId)} kept changing during sync`,
    );
  }

  // ---- Admin reads ----

  async findAll(
    options: {
      coachId?: string | string[];
      search?: string;
      page?: number | string;
      limit?: number | string;
    } = {},
  ): Promise<{
    data: TribeMember[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Math.floor(Number(options.page)) || 1);
    const limit = pageSizeOf(options.limit, 20);
    const skip = (page - 1) * limit;

    const filter: any = {};
    const coaches = coachIdsFilter(options.coachId);
    if (coaches) filter.coachId = coaches;

    const search = String(options.search ?? '').trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { 'addresses.city': regex },
        { 'addresses.pincode': regex },
      ];
    }

    const [data, total] = await Promise.all([
      this.memberModel
        .find(filter)
        // Newest members first: when they joined (their first order).
        .sort({ joinedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate(TRIBE_POPULATE)
        .lean()
        .exec(),
      this.memberModel.countDocuments(filter).exec(),
    ]);

    return {
      data: data as any,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * `coachId` scopes the read to one tribe (a TRIBE caller's own): another
   * tribe's member is "not found", so its existence isn't revealed either.
   */
  async findOne(id: string, coachId?: string): Promise<TribeMember> {
    if (!isValidObjectId(id)) throw new NotFoundException('Member not found');
    const member = await this.memberModel
      .findOne({ _id: id, ...(coachId ? { coachId } : {}) } as any)
      .populate(TRIBE_POPULATE)
      .lean()
      .exec();
    if (!member) throw new NotFoundException('Member not found');
    return member as any;
  }

  /**
   * Every order linked to the member — soft-deleted ones last — populated the
   * way the admin order tables are, so the order view dialog can show them.
   */
  async findOrders(id: string, coachId?: string): Promise<Order[]> {
    if (
      !isValidObjectId(id) ||
      !(await this.memberModel.exists({
        _id: id,
        ...(coachId ? { coachId } : {}),
      } as any))
    ) {
      throw new NotFoundException('Member not found');
    }
    return this.orderModel
      .find({ memberId: id } as any)
      .sort({ isDeleted: 1, createdAt: -1 })
      .populate('items.productId')
      .populate({
        path: 'coachId',
        populate: { path: 'userId', select: 'name email' },
      })
      .populate('campaignId', 'name type packageWeight length breadth height')
      .exec();
  }
}
