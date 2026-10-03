import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product } from '../../schemas/product.schema';
import { InventoryLog } from '../../schemas/inventory-log.schema';
import { ApprovalStatus, Order, OrderStatus } from '../../schemas/order.schema';
import { UNASSIGNED, matchSize } from '../../common/sizes';

// Stock not yet counted into a size: the total minus every size's quantity.
export const unassignedOf = (p: {
  stockLevel?: number;
  sizeStock?: { qty: number }[];
}) =>
  (p.stockLevel || 0) -
  (p.sizeStock || []).reduce((n, s) => n + (s.qty || 0), 0);

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(InventoryLog.name)
    private inventoryLogModel: Model<InventoryLog>,
    @InjectModel(Order.name) private orderModel: Model<Order>,
  ) {}

  async create(productData: any): Promise<Product> {
    const product = new this.productModel(productData);
    return product.save();
  }

  async findAll(): Promise<Product[]> {
    return this.productModel.find({ isDeleted: { $ne: true } } as any).exec();
  }

  async findByCoach(coachId: string): Promise<Product[]> {
    return this.productModel
      .find({ coachId, isDeleted: { $ne: true } } as any)
      .exec();
  }

  // Public storefront listing: only published (isActive), non-deleted products,
  // and without exposing the internal production cost.
  async findActiveByCoach(coachId: string): Promise<Product[]> {
    return (
      this.productModel
        .find({ coachId, isActive: true, isDeleted: { $ne: true } } as any)
        .select('-baseProductionCost -sizeStock')
        .lean()
        .exec()
        // Orders never block on stock, so it can be negative; customers see 0.
        .then((ps: any[]) =>
          ps.map((p) => ({ ...p, stockLevel: Math.max(0, p.stockLevel || 0) })),
        ) as any
    );
  }

  async findDeletedByCoach(coachId: string): Promise<Product[]> {
    return this.productModel.find({ coachId, isDeleted: true } as any).exec();
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productModel.findById(id).exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async update(id: string, productData: any): Promise<Product> {
    const updatedProduct = await this.productModel
      .findByIdAndUpdate(id, productData, { new: true })
      .exec();
    if (!updatedProduct) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return updatedProduct;
  }

  // Tribe-facing store update: only retailPrice / isActive, and only on the
  // coach's own products. `requesterCoachId` is passed for TRIBE callers so we
  // can enforce ownership; ADMIN callers pass undefined and skip the check.
  async updateStoreSettings(
    id: string,
    data: { retailPrice?: number; isActive?: boolean },
    requesterCoachId?: string,
  ): Promise<Product> {
    const product = await this.findOne(id);
    if (
      requesterCoachId &&
      product.coachId?.toString() !== requesterCoachId.toString()
    ) {
      throw new ForbiddenException('You can only update your own products.');
    }
    if (data.retailPrice !== undefined) product.retailPrice = data.retailPrice;
    if (data.isActive !== undefined) product.isActive = data.isActive;
    await product.save();
    return product;
  }

  // Stock never blocks an order or claim — it may go below zero, and that
  // shortfall is what the admin restocks. A size moves its own bucket and the
  // total together; an unknown or missing size moves only the total, i.e. the
  // product's Unassigned stock.
  async decrementStock(id: string, qty: number, size?: string): Promise<void> {
    await this.moveStock(id, -qty, size);
  }

  // Put stock back (order rejected, deleted, returned, or a failed create).
  async incrementStock(id: string, qty: number, size?: string): Promise<void> {
    await this.moveStock(id, qty, size);
  }

  private async moveStock(id: string, delta: number, rawSize?: string) {
    const size = rawSize
      ? matchSize(
          ((await this.productModel
            .findById(id)
            .select('customizationType sizeOptions sizeStock')
            .lean()
            .exec()) as any) || {},
          rawSize,
        )
      : null;
    if (!size) {
      await this.productModel
        .updateOne({ _id: id } as any, { $inc: { stockLevel: delta } })
        .exec();
      return;
    }
    // One atomic update moves the size and the total, so the total stays the
    // sum. A size with no bucket yet gets one; the $ne guard makes two
    // concurrent first orders for a size retry rather than push it twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const hit = await this.productModel
        .updateOne({ _id: id, 'sizeStock.size': size } as any, {
          $inc: { 'sizeStock.$.qty': delta, stockLevel: delta },
        })
        .exec();
      if (hit.matchedCount) return;
      const pushed = await this.productModel
        .updateOne({ _id: id, 'sizeStock.size': { $ne: size } } as any, {
          $push: { sizeStock: { size, qty: delta } },
          $inc: { stockLevel: delta },
        })
        .exec();
      if (pushed.matchedCount) return;
    }
    throw new ConflictException('Could not update stock — please retry');
  }

  // Soft delete: keep the document, flag it as deleted, and deactivate it so it
  // drops out of listings while remaining resolvable from historical orders.
  async remove(id: string): Promise<Product> {
    const result = await this.productModel
      .findByIdAndUpdate(
        id,
        { isDeleted: true, isActive: false },
        { new: true },
      )
      .exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return result;
  }

  async restore(id: string): Promise<Product> {
    const result = await this.productModel
      .findByIdAndUpdate(
        id,
        { isDeleted: false, isActive: true },
        { new: true },
      )
      .exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return result;
  }

  // Manual stock movements. Each one moves `stockLevel` (and, for a sized
  // product, the chosen size — or Unassigned when none is chosen) and writes an
  // InventoryLog entry so the change is auditable with date/time & reason.
  async addInventory(
    id: string,
    quantity: number,
    reason?: string,
    performedBy?: string,
    size?: string,
  ): Promise<Product> {
    return this.adjustInventory(id, 'ADD', quantity, reason, performedBy, size);
  }

  // Unlike orders, a manual removal can't take a size (or Unassigned) below
  // zero — it is a physical correction, so there has to be stock to remove.
  async removeInventory(
    id: string,
    quantity: number,
    reason: string,
    performedBy?: string,
    size?: string,
  ): Promise<Product> {
    return this.adjustInventory(
      id,
      'REMOVE',
      quantity,
      reason,
      performedBy,
      size,
    );
  }

  private async adjustInventory(
    id: string,
    type: 'ADD' | 'REMOVE',
    quantity: number,
    reason: string | undefined,
    performedBy: string | undefined,
    rawSize?: string,
  ): Promise<Product> {
    const product = await this.findOne(id);
    const sized = product.customizationType === 'SIZE';
    const size = rawSize ? matchSize(product, rawSize) : null;
    if (rawSize && !size) {
      throw new BadRequestException(
        `"${rawSize}" is not a size of ${product.name}.`,
      );
    }
    const delta = type === 'ADD' ? quantity : -quantity;

    if (type === 'REMOVE') {
      const available = size
        ? ((product.sizeStock || []).find((s) => s.size === size)?.qty ?? 0)
        : sized
          ? unassignedOf(product)
          : product.stockLevel || 0;
      if (available - quantity < 0) {
        const where = size
          ? ` in size ${size}`
          : sized
            ? ` in ${UNASSIGNED}`
            : '';
        throw new BadRequestException(
          `Cannot remove ${quantity} units — only ${Math.max(0, available)} in stock${where}.`,
        );
      }
    }

    await this.moveStock(id, delta, size || undefined);
    const updated = await this.findOne(id);
    await this.inventoryLogModel.create({
      productId: updated._id,
      coachId: updated.coachId,
      type,
      quantity,
      reason,
      resultingStock: updated.stockLevel,
      performedBy,
      ...(sized ? { size: size || UNASSIGNED } : {}),
    } as any);
    return updated;
  }

  // Every sized product across tribes, for the admin's size-stock page. Each
  // carries `promised`: units on open orders (placed, not yet dispatched) by
  // the size as written on the order. Stock is deducted when an order is
  // placed, so those units are still on the shelf — the page needs them to turn
  // a shelf count into available stock.
  async findSized(): Promise<any[]> {
    const products: any[] = await this.productModel
      .find({ customizationType: 'SIZE', isDeleted: { $ne: true } } as any)
      .select(
        'name sku imageUrl coachId stockLevel customizationType sizeOptions disabledSizes sizeStock updatedAt',
      )
      .populate('coachId', 'name brand username')
      .sort({ coachId: 1, name: 1 })
      .lean()
      .exec();
    if (!products.length) return [];

    const open = await this.orderModel
      .aggregate([
        {
          $match: {
            status: { $in: [OrderStatus.NEW, OrderStatus.PACKED] },
            approvalStatus: { $ne: ApprovalStatus.REJECTED },
            isDeleted: { $ne: true },
            'items.productId': { $in: products.map((p) => p._id) },
          },
        },
        { $unwind: '$items' },
        // A kit item dropped at approval stays on the order with selected:false
        // and never ships, so it isn't holding a unit.
        {
          $match: {
            'items.productId': { $in: products.map((p) => p._id) },
            'items.selected': { $ne: false },
          },
        },
        {
          $group: {
            _id: { p: '$items.productId', s: '$items.customizationValue' },
            qty: { $sum: '$items.quantity' },
          },
        },
      ])
      .exec();

    const promised = new Map<string, { size: string; qty: number }[]>();
    for (const g of open) {
      const key = String(g._id.p);
      const list = promised.get(key) || [];
      list.push({ size: g._id.s ?? '', qty: g.qty });
      promised.set(key, list);
    }
    return products.map((p) => {
      // Fold each order's spelling of a size ("m") onto the product's ("M");
      // anything unrecognised is promised out of Unassigned.
      const bySize: Record<string, number> = {};
      for (const o of promised.get(String(p._id)) || []) {
        const key = matchSize(p, o.size) || UNASSIGNED;
        bySize[key] = (bySize[key] || 0) + o.qty;
      }
      return { ...p, promised: bySize };
    });
  }

  // Set a product's per-size stock (and Unassigned) to the counts the admin
  // entered. The total becomes their sum, so this both splits existing stock
  // and corrects it to a physical count; every bucket that changes is logged.
  // `expectedUpdatedAt` is the version the admin was looking at: if an order or
  // another adjustment has moved stock since, nothing is written.
  async setSizeStock(
    id: string,
    input: {
      sizes: { size: string; qty: number }[];
      unassigned: number;
      reason?: string;
      expectedUpdatedAt: string;
    },
    performedBy?: string,
  ): Promise<Product> {
    const product = await this.findOne(id);
    if (product.customizationType !== 'SIZE') {
      throw new BadRequestException(`${product.name} has no sizes.`);
    }
    const current = new Map(
      (product.sizeStock || []).map((s) => [s.size, s.qty]),
    );
    const next = new Map(current);
    for (const row of input.sizes || []) {
      const size = matchSize(product, row.size);
      if (!size)
        throw new BadRequestException(
          `"${row.size}" is not a size of ${product.name}.`,
        );
      if (!Number.isInteger(row.qty))
        throw new BadRequestException(`Size ${size} needs a whole number.`);
      next.set(size, row.qty);
    }
    if (!Number.isInteger(input.unassigned)) {
      throw new BadRequestException(`${UNASSIGNED} needs a whole number.`);
    }
    const buckets = [...next].map(([size, qty]) => ({ size, qty }));
    const total = buckets.reduce((n, b) => n + b.qty, 0) + input.unassigned;

    const res = await this.productModel
      .updateOne(
        { _id: id, updatedAt: new Date(input.expectedUpdatedAt) } as any,
        { $set: { sizeStock: buckets, stockLevel: total } },
      )
      .exec();
    if (!res.matchedCount) {
      throw new ConflictException(
        'Stock for this product changed since you opened it (a new order or adjustment). Reload and enter the counts again.',
      );
    }

    const reason = input.reason?.trim() || 'Size stock update';
    const changes: { size: string; d: number }[] = [];
    for (const [size, qty] of next) {
      const d = qty - (current.get(size) ?? 0);
      if (d) changes.push({ size, d });
    }
    const dUnassigned = input.unassigned - unassignedOf(product);
    if (dUnassigned) changes.push({ size: UNASSIGNED, d: dUnassigned });
    if (changes.length) {
      await this.inventoryLogModel.insertMany(
        changes.map((c) => ({
          productId: product._id,
          coachId: product.coachId,
          type: c.d > 0 ? 'ADD' : 'REMOVE',
          quantity: Math.abs(c.d),
          reason,
          resultingStock: total,
          performedBy,
          size: c.size,
        })) as any,
      );
    }
    return this.findOne(id);
  }

  async getInventoryLogs(id: string): Promise<InventoryLog[]> {
    return this.inventoryLogModel
      .find({ productId: id } as any)
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }
}
