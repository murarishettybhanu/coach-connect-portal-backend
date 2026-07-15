import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { PublicProductsController } from './public-products.controller';
import { Product, ProductSchema } from '../../schemas/product.schema';
import {
  InventoryLog,
  InventoryLogSchema,
} from '../../schemas/inventory-log.schema';
import { TribesModule } from '../tribes/tribes.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: InventoryLog.name, schema: InventoryLogSchema },
    ]),
    TribesModule,
  ],
  providers: [ProductsService],
  controllers: [ProductsController, PublicProductsController],
  exports: [ProductsService],
})
export class ProductsModule {}
