import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

// Public, unauthenticated storefront endpoints. Kept on a separate base path
// (`/storefront`) so it isn't caught by the guarded ProductsController's
// `products/:id` route. Returns only published (isActive) products.
@Controller('storefront')
export class PublicProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('products')
  findActive(@Query('coachId') coachId: string) {
    if (!coachId) return [];
    return this.productsService.findActiveByCoach(coachId);
  }
}
