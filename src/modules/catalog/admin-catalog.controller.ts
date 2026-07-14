import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

// Admin CRUD for the master catalog (categories, products, kits).
@Controller('admin/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /* Categories */
  @Post('categories')
  createCategory(@Body() body: any) {
    return this.catalog.createCategory(body);
  }
  @Get('categories')
  listCategories() {
    return this.catalog.listCategories();
  }
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: any) {
    return this.catalog.updateCategory(id, body);
  }
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.catalog.deleteCategory(id);
  }

  /* Products */
  @Post('products')
  createProduct(@Body() body: any) {
    return this.catalog.createProduct(body);
  }
  @Get('products')
  listProducts(@Query('categoryId') categoryId?: string) {
    return this.catalog.listProducts({ categoryId });
  }
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.catalog.updateProduct(id, body);
  }
  @Delete('products/:id')
  deleteProduct(@Param('id') id: string) {
    return this.catalog.deleteProduct(id);
  }

  /* Kits */
  @Post('kits')
  createKit(@Body() body: any) {
    return this.catalog.createKit(body);
  }
  @Get('kits')
  listKits() {
    return this.catalog.listKits();
  }
  @Patch('kits/:id')
  updateKit(@Param('id') id: string, @Body() body: any) {
    return this.catalog.updateKit(id, body);
  }
  @Delete('kits/:id')
  deleteKit(@Param('id') id: string) {
    return this.catalog.deleteKit(id);
  }
}
