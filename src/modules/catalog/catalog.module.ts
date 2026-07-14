import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from '../../schemas/category.schema';
import {
  CatalogProduct,
  CatalogProductSchema,
} from '../../schemas/catalog-product.schema';
import { Kit, KitSchema } from '../../schemas/kit.schema';
import {
  QuoteRequest,
  QuoteRequestSchema,
} from '../../schemas/quote-request.schema';
import { CatalogService } from './catalog.service';
import { QuoteRequestsService } from './quote-requests.service';
import { AdminCatalogController } from './admin-catalog.controller';
import { PublicCatalogController } from './public-catalog.controller';
import { EstimationsController } from './estimations.controller';
import { RequestsController } from './requests.controller';
import { CoachesModule } from '../coaches/coaches.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: CatalogProduct.name, schema: CatalogProductSchema },
      { name: Kit.name, schema: KitSchema },
      { name: QuoteRequest.name, schema: QuoteRequestSchema },
    ]),
    CoachesModule,
  ],
  providers: [CatalogService, QuoteRequestsService],
  controllers: [
    AdminCatalogController,
    PublicCatalogController,
    EstimationsController,
    RequestsController,
  ],
})
export class CatalogModule {}
