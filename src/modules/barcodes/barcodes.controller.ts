import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { BarcodesService } from './barcodes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { BulkCreateBarcodesDto } from './dto/bulk-create-barcodes.dto';

// Admin-only barcode management.
@Controller('barcodes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class BarcodesController {
  constructor(private readonly barcodesService: BarcodesService) {}

  @Post('bulk')
  bulkCreate(@Body() dto: BulkCreateBarcodesDto) {
    return this.barcodesService.bulkCreate(dto.type, dto.codes);
  }

  @Get('stats')
  stats() {
    return this.barcodesService.stats();
  }

  @Get()
  list(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.barcodesService.list({
      type,
      status,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
