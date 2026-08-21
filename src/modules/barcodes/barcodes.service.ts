import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Barcode, BarcodeType } from '../../schemas/barcode.schema';

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
          used: { $sum: { $cond: [{ $ne: ['$assignedOrderId', null] }, 1, 0] } },
        },
      },
    ]);
    const empty = { total: 0, used: 0, available: 0 };
    const out: Record<string, { total: number; used: number; available: number }> = {
      [BarcodeType.SPEED_POST]: { ...empty },
      [BarcodeType.BUSINESS_PARCEL]: { ...empty },
    };
    for (const r of rows) {
      out[r._id] = { total: r.total, used: r.used, available: r.total - r.used };
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
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const filter: any = {};
    if (options.type) filter.type = options.type;
    if (options.status === 'available') filter.assignedOrderId = null;
    if (options.status === 'used') filter.assignedOrderId = { $ne: null };
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
    return this.barcodeModel.findOne({ assignedOrderId: orderId } as any).exec();
  }

  // Atomically claim the next available barcode of `type` for `orderId`.
  // Idempotent: if the order already holds a barcode, that one is returned and no
  // new barcode is claimed. Returns null if none are available.
  async assignToOrder(orderId: string, type: BarcodeType): Promise<Barcode | null> {
    const existing = await this.findByOrder(orderId);
    if (existing) return existing;
    return this.barcodeModel
      .findOneAndUpdate(
        { type, assignedOrderId: null } as any,
        { $set: { assignedOrderId: orderId, assignedAt: new Date() } },
        { new: true, sort: { createdAt: 1 } },
      )
      .exec();
  }

  // Atomically claim the next available barcode of `type` for `orderId` WITHOUT the
  // idempotency check — used when reassigning to a different delivery type.
  async claim(orderId: string, type: BarcodeType): Promise<Barcode | null> {
    return this.barcodeModel
      .findOneAndUpdate(
        { type, assignedOrderId: null } as any,
        { $set: { assignedOrderId: orderId, assignedAt: new Date() } },
        { new: true, sort: { createdAt: 1 } },
      )
      .exec();
  }

  // Return a specific barcode to the available pool.
  async releaseOne(barcodeId: any): Promise<void> {
    await this.barcodeModel
      .updateOne(
        { _id: barcodeId } as any,
        { $set: { assignedOrderId: null, assignedAt: null } },
      )
      .exec();
  }

  // Return any barcode(s) held by an order to the available pool.
  async releaseFromOrder(orderId: string): Promise<void> {
    await this.barcodeModel
      .updateMany(
        { assignedOrderId: orderId } as any,
        { $set: { assignedOrderId: null, assignedAt: null } },
      )
      .exec();
  }
}
