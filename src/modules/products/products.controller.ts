import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Request,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { AddInventoryDto, RemoveInventoryDto } from './dto/inventory.dto';

@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() productData: any) {
    return this.productsService.create(productData);
  }

  @Get()
  findAll(
    @Query('coachId') coachId?: string,
    @Query('deleted') deleted?: string,
  ) {
    if (coachId) {
      // `?deleted=true` returns only the coach's soft-deleted products so the
      // admin can review and recover them.
      return deleted === 'true'
        ? this.productsService.findDeletedByCoach(coachId)
        : this.productsService.findByCoach(coachId);
    }
    return this.productsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() productData: any) {
    return this.productsService.update(id, productData);
  }

  @Patch(':id/restore')
  @Roles(UserRole.ADMIN)
  restore(@Param('id') id: string) {
    return this.productsService.restore(id);
  }

  @Patch(':id/inventory/add')
  @Roles(UserRole.ADMIN)
  addInventory(
    @Param('id') id: string,
    @Body() dto: AddInventoryDto,
    @Request() req: any,
  ) {
    return this.productsService.addInventory(
      id,
      dto.quantity,
      dto.reason,
      req.user?._id,
    );
  }

  @Patch(':id/inventory/remove')
  @Roles(UserRole.ADMIN)
  removeInventory(
    @Param('id') id: string,
    @Body() dto: RemoveInventoryDto,
    @Request() req: any,
  ) {
    return this.productsService.removeInventory(
      id,
      dto.quantity,
      dto.reason,
      req.user?._id,
    );
  }

  @Get(':id/inventory/logs')
  @Roles(UserRole.ADMIN)
  inventoryLogs(@Param('id') id: string) {
    return this.productsService.getInventoryLogs(id);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }
}
