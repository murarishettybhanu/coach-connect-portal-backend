import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { BarcodesService } from './barcodes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { BulkCreateBarcodesDto } from './dto/bulk-create-barcodes.dto';
import { MarkBarcodeUsedDto } from './dto/mark-used.dto';

// JwtStrategy puts the authenticated user on the request; only the id is read
// here, to record who wrote a barcode off.
interface AuthedRequest {
  user?: { userId?: string; sub?: string; _id?: string };
}

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

  // Take a barcode out of the pool with no order behind it — a damaged label,
  // or one used outside the system.
  @Patch(':id/mark-used')
  markUsed(
    @Param('id') id: string,
    @Body() dto: MarkBarcodeUsedDto,
    @Request() req: AuthedRequest,
  ) {
    const userId = req.user?.userId || req.user?.sub || req.user?._id;
    return this.barcodesService.markUsed(id, {
      note: dto.note,
      userId: userId ? String(userId) : undefined,
    });
  }

  // Undo a manual write-off. Refuses barcodes held by an order.
  @Patch(':id/release')
  release(@Param('id') id: string) {
    return this.barcodesService.unmarkUsed(id);
  }
}
