import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Category } from '../../schemas/category.schema';
import { CatalogProduct } from '../../schemas/catalog-product.schema';
import { Kit } from '../../schemas/kit.schema';

// Manages the admin-owned master catalog: categories, catalog products and
// predefined kits. All reads exclude soft-deleted records.
@Injectable()
export class CatalogService {
  constructor(
    @InjectModel(Category.name) private categoryModel: Model<Category>,
    @InjectModel(CatalogProduct.name)
    private productModel: Model<CatalogProduct>,
    @InjectModel(Kit.name) private kitModel: Model<Kit>,
  ) {}

  /* ── Categories ── */
  createCategory(data: any) {
    return this.categoryModel.create(data);
  }
  listCategories(activeOnly = false) {
    const filter: any = { isDeleted: { $ne: true } };
    if (activeOnly) filter.isActive = true;
    return this.categoryModel.find(filter).sort({ sortOrder: 1, name: 1 }).exec();
  }
  async updateCategory(id: string, data: any) {
    const doc = await this.categoryModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('Category not found');
    return doc;
  }
  deleteCategory(id: string) {
    return this.categoryModel
      .findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true })
      .exec();
  }

  /* ── Catalog products ── */
  createProduct(data: any) {
    return this.productModel.create(data);
  }
  listProducts(opts: { categoryId?: string; activeOnly?: boolean } = {}) {
    const filter: any = { isDeleted: { $ne: true } };
    if (opts.categoryId) filter.categoryId = opts.categoryId;
    if (opts.activeOnly) filter.isActive = true;
    return this.productModel
      .find(filter)
      .populate('categoryId', 'name')
      .sort({ createdAt: -1 })
      .exec();
  }
  async updateProduct(id: string, data: any) {
    const doc = await this.productModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('Product not found');
    return doc;
  }
  deleteProduct(id: string) {
    return this.productModel
      .findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true })
      .exec();
  }

  /* ── Kits ── */
  createKit(data: any) {
    return this.kitModel.create(data);
  }
  listKits(activeOnly = false) {
    const filter: any = { isDeleted: { $ne: true } };
    if (activeOnly) filter.isActive = true;
    return this.kitModel
      .find(filter)
      .populate({ path: 'items.productId', select: 'name price imageUrl' })
      .sort({ createdAt: -1 })
      .exec();
  }
  async updateKit(id: string, data: any) {
    const doc = await this.kitModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('Kit not found');
    return doc;
  }
  deleteKit(id: string) {
    return this.kitModel
      .findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true })
      .exec();
  }

  // Resolve a list of {productId, quantity} into priced snapshot line items
  // using the current catalog prices. Skips missing/inactive products.
  async priceItems(
    raw: { productId: string; quantity: number }[],
  ): Promise<{ items: any[]; total: number }> {
    const ids = raw.map((r) => r.productId);
    const products = await this.productModel
      .find({ _id: { $in: ids }, isDeleted: { $ne: true } } as any)
      .exec();
    const byId = new Map(products.map((p) => [p._id.toString(), p]));
    const items: any[] = [];
    let total = 0;
    for (const r of raw) {
      const p = byId.get(String(r.productId));
      if (!p) continue;
      const quantity = Math.max(1, Number(r.quantity) || 1);
      const price = p.price || 0;
      total += price * quantity;
      items.push({ productId: p._id, name: p.name, quantity, price });
    }
    return { items, total };
  }

  findKit(id: string) {
    return this.kitModel.findById(id).exec();
  }
}
