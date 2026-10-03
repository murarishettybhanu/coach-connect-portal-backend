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
import {
  AddInventoryDto,
  RemoveInventoryDto,
  SetSizeStockDto,
} from './dto/inventory.dto';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import { TribesService } from '../tribes/tribes.service';

// Stock shortfalls (negative stock) are for the admin only: everyone else sees
// stock floored at zero.
function hideShortfall<T>(p: T): T {
  const doc: any = (p as any)?.toObject ? (p as any).toObject() : p;
  if (!doc) return p;
  return {
    ...doc,
    stockLevel: Math.max(0, doc.stockLevel || 0),
    ...(doc.sizeStock
      ? {
          sizeStock: doc.sizeStock.map((s: any) => ({
            ...s,
            qty: Math.max(0, s.qty || 0),
          })),
        }
      : {}),
  };
}
const forRole = (req: any, data: any) =>
  req?.user?.role === UserRole.ADMIN
    ? data
    : Array.isArray(data)
      ? data.map(hideShortfall)
      : hideShortfall(data);

@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly tribesService: TribesService,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() productData: any) {
    return this.productsService.create(productData);
  }

  @Get()
  async findAll(
    @Request() req: any,
    @Query('coachId') coachId?: string,
    @Query('deleted') deleted?: string,
  ) {
    if (coachId) {
      // `?deleted=true` returns only the coach's soft-deleted products so the
      // admin can review and recover them.
      return forRole(
        req,
        deleted === 'true'
          ? await this.productsService.findDeletedByCoach(coachId)
          : await this.productsService.findByCoach(coachId),
      );
    }
    return forRole(req, await this.productsService.findAll());
  }

  // Every sized product across tribes, with per-size stock (admin size-stock page).
  // Declared before `:id` so "sized" isn't read as a product id.
  @Get('sized')
  @Roles(UserRole.ADMIN)
  findSized() {
    return this.productsService.findSized();
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return forRole(req, await this.productsService.findOne(id));
  }

  // Set per-size stock (split Unassigned into sizes and/or correct to a count).
  @Patch(':id/size-stock')
  @Roles(UserRole.ADMIN)
  setSizeStock(
    @Param('id') id: string,
    @Body() dto: SetSizeStockDto,
    @Request() req: any,
  ) {
    return this.productsService.setSizeStock(id, dto, req.user?._id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() productData: any) {
    return this.productsService.update(id, productData);
  }

  // Coaches (and admins) can set retail price / publish state on the store.
  // Coaches are restricted to their own products by ownership check.
  @Patch(':id/store-settings')
  @Roles(UserRole.ADMIN, UserRole.TRIBE)
  async updateStoreSettings(
    @Param('id') id: string,
    @Body() dto: UpdateStoreSettingsDto,
    @Request() req: any,
  ) {
    let coachId: string | undefined;
    if (req.user.role === UserRole.TRIBE) {
      const coach = await this.tribesService.findByUserId(
        req.user.userId || req.user.sub || req.user._id,
      );
      coachId = coach._id;
    }
    return this.productsService.updateStoreSettings(id, dto, coachId);
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
      dto.size,
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
      dto.size,
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
