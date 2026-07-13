import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product } from '../../schemas/product.schema';
import { InventoryLog } from '../../schemas/inventory-log.schema';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(InventoryLog.name)
    private inventoryLogModel: Model<InventoryLog>,
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

  async findDeletedByCoach(coachId: string): Promise<Product[]> {
    return this.productModel
      .find({ coachId, isDeleted: true } as any)
      .exec();
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

  // Soft delete: keep the document, flag it as deleted, and deactivate it so it
  // drops out of listings while remaining resolvable from historical orders.
  async remove(id: string): Promise<Product> {
    const result = await this.productModel
      .findByIdAndUpdate(id, { isDeleted: true, isActive: false }, { new: true })
      .exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return result;
  }

  async restore(id: string): Promise<Product> {
    const result = await this.productModel
      .findByIdAndUpdate(id, { isDeleted: false, isActive: true }, { new: true })
      .exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return result;
  }

  // Manual stock movements. Each one bumps `stockLevel` and writes an
  // InventoryLog entry so the change is auditable with date/time & reason.
  async addInventory(
    id: string,
    quantity: number,
    reason?: string,
    performedBy?: string,
  ): Promise<Product> {
    const product = await this.findOne(id);
    product.stockLevel = (product.stockLevel || 0) + quantity;
    await product.save();
    await this.inventoryLogModel.create({
      productId: product._id,
      coachId: product.coachId,
      type: 'ADD',
      quantity,
      reason,
      resultingStock: product.stockLevel,
      performedBy,
    } as any);
    return product;
  }

  async removeInventory(
    id: string,
    quantity: number,
    reason: string,
    performedBy?: string,
  ): Promise<Product> {
    const product = await this.findOne(id);
    const newStock = (product.stockLevel || 0) - quantity;
    if (newStock < 0) {
      throw new BadRequestException(
        `Cannot remove ${quantity} units — only ${product.stockLevel || 0} in stock.`,
      );
    }
    product.stockLevel = newStock;
    await product.save();
    await this.inventoryLogModel.create({
      productId: product._id,
      coachId: product.coachId,
      type: 'REMOVE',
      quantity,
      reason,
      resultingStock: newStock,
      performedBy,
    } as any);
    return product;
  }

  async getInventoryLogs(id: string): Promise<InventoryLog[]> {
    return this.inventoryLogModel
      .find({ productId: id } as any)
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }
}
