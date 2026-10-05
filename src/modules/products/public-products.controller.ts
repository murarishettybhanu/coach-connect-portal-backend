import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { TribesService } from '../tribes/tribes.service';

// Public, unauthenticated storefront endpoints. Kept on a separate base path
// (`/storefront`) so it isn't caught by the guarded ProductsController's
// `products/:id` route. Returns only published (isActive) products.
@Controller('storefront')
export class PublicProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly tribesService: TribesService,
  ) {}

  @Get('products')
  async findActive(@Query('coachId') coachId: string) {
    if (!coachId) return [];
    // A tribe whose public storefront is switched off sells nothing here.
    const allowed = await this.tribesService.permissionsOf(coachId).catch(() => null);
    if (!allowed?.storefront) return [];
    return this.productsService.findActiveByCoach(coachId);
  }
}
