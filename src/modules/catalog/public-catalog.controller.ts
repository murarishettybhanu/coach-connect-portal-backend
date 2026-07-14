import { Controller, Get, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';

// Public, unauthenticated catalog for the store / estimation flows. Returns
// only active, non-deleted records.
@Controller('catalog')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories() {
    return this.catalog.listCategories(true);
  }

  @Get('products')
  products(@Query('categoryId') categoryId?: string) {
    return this.catalog.listProducts({ categoryId, activeOnly: true });
  }

  @Get('kits')
  kits() {
    return this.catalog.listKits(true);
  }
}
