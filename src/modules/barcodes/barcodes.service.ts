import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Barcode, BarcodeType } from '../../schemas/barcode.schema';
import { pageSizeOf } from '../../common/utils/pagination.util';

// The single definition of "nothing is holding this barcode". Every claim path
// MUST filter on this: miss it in one place and a written-off barcode gets
// handed to a real parcel, which is a duplicate tracking number in the post.
const AVAILABLE = { assignedOrderId: null, manuallyUsedAt: null } as const;

@Injectable()
export class BarcodesService {
  constructor(
    @InjectModel(Barcode.name) private barcodeModel: Model<Barcode>,
  ) {}

  // Bulk-insert uploaded codes of a type. De-dupes within the payload and skips
  // codes that already exist (the unique index rejects them).
  async bulkCreate(type: BarcodeType, codes: string[]) {
    const clean = [
      ...new Set((codes || []).map((c) => String(c).trim()).filter(Boolean)),
    ];
    if (!clean.length) return { inserted: 0, skipped: 0, total: 0 };

    const docs = clean.map((code) => ({ code, type, assignedOrderId: null }));
    let inserted = 0;
    try {
      const res = await this.barcodeModel.insertMany(docs, { ordered: false });
      inserted = res.length;
    } catch (err: any) {
      // Only "already exists" counts as skipped. Anything else (a validation
      // failure, a dropped connection) means codes the admin uploaded were
      // NOT stored, and must not be reported as a quiet partial success.
      if (!isOnlyDuplicateKeyErrors(err)) throw err;
      // ordered:false → partial success; mongoose exposes the inserted docs.
      inserted = err?.insertedDocs?.length ?? 0;
    }
    return { inserted, skipped: clean.length - inserted, total: clean.length };
  }

  // Available / used / total counts per type for the dashboard.
  async stats() {
    const rows = await this.barcodeModel.aggregate([
      {
        $group: {
          _id: '$type',
          total: { $sum: 1 },
          // Same rule as AVAILABLE above. In an aggregation a *missing* field
          // is not equal to null (unlike in a find filter), and barcodes
          // uploaded before manual write-offs existed have no manuallyUsedAt
          // at all — so coalesce missing to null before comparing.
          used: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $ne: [{ $ifNull: ['$assignedOrderId', null] }, null] },
                    { $ne: [{ $ifNull: ['$manuallyUsedAt', null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const empty = { total: 0, used: 0, available: 0 };
    const out: Record<
      string,
      { total: number; used: number; available: number }
    > = {
      [BarcodeType.SPEED_POST]: { ...empty },
      [BarcodeType.BUSINESS_PARCEL]: { ...empty },
    };
    for (const r of rows) {
      out[r._id] = {
        total: r.total,
        used: r.used,
        available: r.total - r.used,
      };
    }
    return out;
  }

  async list(options: {
    type?: string;
    status?: string; // 'available' | 'used'
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = pageSizeOf(options.limit, 50);
    const filter: any = {};
    if (options.type) filter.type = options.type;
    if (options.status === 'available') Object.assign(filter, AVAILABLE);
    if (options.status === 'used') {
      filter.$or = [
        { assignedOrderId: { $ne: null } },
        { manuallyUsedAt: { $ne: null } },
      ];
    }
    if (options.search?.trim()) {
      const esc = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.code = { $regex: esc, $options: 'i' };
    }
    const [data, total] = await Promise.all([
      this.barcodeModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.barcodeModel.countDocuments(filter),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ---- Assignment (critical: strictly one barcode per order, one order per barcode) ----

  async findByOrder(orderId: string): Promise<Barcode | null> {
    return this.barcodeModel
      .findOne({ assignedOrderId: orderId } as any)
      .exec();
  }

  /**
   * Claim the next available barcode of `type` for `orderId`. Idempotent: an
   * order already holding a barcode of that type gets the same one back.
   * Returns null when none of the type are available.
   *
   * "One barcode per order" is enforced by a unique index on
   * `assignedOrderId`, not by the read below — two concurrent packs of the
   * same order both see "nothing held", both try to claim, and the loser's
   * write fails with a duplicate key. The loser then re-reads and returns the
   * winner's barcode, so both callers agree.
   */
  async assignToOrder(
    orderId: string,
    type: BarcodeType,
  ): Promise<Barcode | null> {
    const existing = await this.findByOrder(orderId);
    if (existing) {
      if (existing.type === type) return existing;
      return this.switchType(orderId, existing, type);
    }
    try {
      return await this.barcodeModel
        .findOneAndUpdate(
          { type, ...AVAILABLE },
          { $set: { assignedOrderId: orderId, assignedAt: new Date() } },
          { new: true, sort: { createdAt: 1 } },
        )
        .exec();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return this.findByOrder(orderId);
    }
  }

  /**
   * The order's delivery type changed after it was given a barcode (re-packed
   * as Business Parcel instead of Speed Post). Swap it for one of the right
   * type — without ever leaving the order empty-handed while the old code is
   * back in the pool, since the order still shows that code until it saves.
   *
   * The replacement is reserved first (marked as written off, so no one else
   * can take it), then the old barcode is released, then the reservation is
   * turned into the assignment. If none of the new type are available nothing
   * changes and null is returned, which the order flow reads as "pending".
   */
  private async switchType(
    orderId: string,
    current: Barcode,
    type: BarcodeType,
  ): Promise<Barcode | null> {
    const reservedAt = new Date();
    const reserved = await this.barcodeModel
      .findOneAndUpdate(
        { type, ...AVAILABLE },
        {
          $set: {
            manuallyUsedAt: reservedAt,
            manualUseNote: `Reserved for order ${orderId} (delivery type change)`,
          },
        },
        { new: true, sort: { createdAt: 1 } },
      )
      .exec();
    if (!reserved) return null;

    await this.barcodeModel
      .updateOne({ _id: current._id, assignedOrderId: orderId } as any, {
        $set: { assignedOrderId: null, assignedAt: null },
      })
      .exec();

    try {
      return await this.barcodeModel
        .findOneAndUpdate(
          { _id: reserved._id, manuallyUsedAt: reservedAt },
          {
            $set: {
              assignedOrderId: orderId,
              assignedAt: new Date(),
              manuallyUsedAt: null,
            },
            $unset: { manualUseNote: '' },
          },
          { new: true },
        )
        .exec();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // A concurrent pack of the same order got there first: hand the
      // reservation back and go with whatever the order now holds.
      await this.releaseOne(reserved._id);
      return this.findByOrder(orderId);
    }
  }

  // Return a specific barcode to the available pool.
  async releaseOne(barcodeId: any): Promise<void> {
    await this.barcodeModel
      .updateOne(
        { _id: barcodeId },
        {
          $set: {
            assignedOrderId: null,
            assignedAt: null,
            manuallyUsedAt: null,
            manuallyUsedBy: null,
          },
          $unset: { manualUseNote: '' },
        },
      )
      .exec();
  }

  // Return any barcode(s) held by an order to the available pool.
  async releaseFromOrder(orderId: string): Promise<void> {
    await this.barcodeModel
      .updateMany({ assignedOrderId: orderId } as any, {
        $set: { assignedOrderId: null, assignedAt: null },
      })
      .exec();
  }

  /**
   * Take a barcode out of the available pool without an order behind it — a
   * damaged label, or one used outside the system. Conditional on the barcode
   * still being available, so it cannot race an order claiming it: if an order
   * wins, nothing is written and the caller is told.
   */
  async markUsed(
    barcodeId: string,
    opts: { note?: string; userId?: string } = {},
  ): Promise<Barcode> {
    const existing = await this.barcodeModel.findById(barcodeId).exec();
    if (!existing) throw new NotFoundException('Barcode not found');
    if (existing.assignedOrderId) {
      throw new BadRequestException(
        'This barcode is already assigned to an order',
      );
    }
    if (existing.manuallyUsedAt) return existing;

    const updated = await this.barcodeModel
      .findOneAndUpdate(
        { _id: barcodeId, ...AVAILABLE },
        {
          $set: {
            manuallyUsedAt: new Date(),
            manuallyUsedBy: opts.userId ?? null,
            ...(opts.note?.trim() ? { manualUseNote: opts.note.trim() } : {}),
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new BadRequestException(
        'That barcode was claimed by an order just now — refresh and try again',
      );
    }
    return updated;
  }

  /**
   * Undo a manual write-off. Refuses a barcode held by an order: releasing that
   * would leave a dispatched parcel's tracking number back in the pool, to be
   * handed to somebody else's shipment.
   */
  async unmarkUsed(barcodeId: string): Promise<Barcode> {
    const existing = await this.barcodeModel.findById(barcodeId).exec();
    if (!existing) throw new NotFoundException('Barcode not found');
    if (existing.assignedOrderId) {
      throw new BadRequestException(
        'This barcode belongs to an order — release it from the order instead',
      );
    }
    if (!existing.manuallyUsedAt) return existing;

    const updated = await this.barcodeModel
      .findByIdAndUpdate(
        barcodeId,
        {
          $set: { manuallyUsedAt: null, manuallyUsedBy: null },
          $unset: { manualUseNote: '' },
        },
        { new: true },
      )
      .exec();
    return updated as Barcode;
  }
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/** True when every failure in an unordered insertMany was a duplicate key. */
function isOnlyDuplicateKeyErrors(err: any): boolean {
  const writeErrors: any[] | undefined = err?.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length) {
    return writeErrors.every(
      (e) => (e?.code ?? e?.err?.code ?? e?.err?.errInfo?.code) === 11000,
    );
  }
  return isDuplicateKey(err);
}
