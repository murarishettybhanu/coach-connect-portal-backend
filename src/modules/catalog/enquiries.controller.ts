import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EnquiriesService } from './enquiries.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { CreateEnquiryDto, UpdateEnquiryDto } from './dto/enquiry.dto';

// Public submit endpoint for the marketing "Request a Quote" form.
@Controller('enquiries')
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Post()
  create(@Body() dto: CreateEnquiryDto) {
    return this.enquiries.create(dto);
  }
}

// Admin review of website enquiries.
@Controller('admin/enquiries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get()
  list() {
    return this.enquiries.list();
  }

  // Polled by every admin page: the unread badge + new-enquiry pop-ups.
  @Get('unread')
  unread() {
    return this.enquiries.unread();
  }

  // Opening an enquiry in the portal marks it read.
  @Patch(':id/seen')
  markSeen(@Param('id') id: string) {
    return this.enquiries.markSeen(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnquiryDto) {
    return this.enquiries.update(id, dto);
  }
}
