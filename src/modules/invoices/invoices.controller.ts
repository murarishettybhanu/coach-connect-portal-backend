import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Observable, catchError, throwError } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../schemas/user.schema';
import { InvoiceFile, InvoicesService } from './invoices.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import {
  MAX_INVOICE_PDF_BYTES,
  PDF_TOO_LARGE,
  contentDisposition,
  wantsDownload,
} from './invoice-file';

/**
 * Multer reports an oversized file as a 413; the contract wants the 400
 * "PDF must be 10 MB or smaller". Listed before the FileInterceptor so it
 * wraps it.
 */
@Injectable()
export class PdfTooLargeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((err) =>
          throwError(() =>
            err instanceof PayloadTooLargeException
              ? new BadRequestException(PDF_TOO_LARGE)
              : err,
          ),
        ),
      );
  }
}

// Memory storage (the PDF's bytes are checked before anything is stored),
// one file, 10 MB. The client's mimetype is deliberately not filtered on.
const pdfUpload = () =>
  UseInterceptors(
    PdfTooLargeInterceptor,
    FileInterceptor('file', {
      limits: { fileSize: MAX_INVOICE_PDF_BYTES, files: 1, fields: 20 },
    }),
  );

// Same ceiling as image uploads get per route.
const UPLOAD_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/** Sets the PDF headers and hands the S3 stream to Nest to pipe out. */
export function sendPdf(
  res: Response,
  file: InvoiceFile,
  download: boolean,
): StreamableFile {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition(file.invoiceNumber, download),
    'X-Content-Type-Options': 'nosniff',
    // Financial documents: never kept by shared caches or the browser.
    'Cache-Control': 'private, no-store',
  });
  if (typeof file.contentLength === 'number') {
    res.set('Content-Length', String(file.contentLength));
  }
  return new StreamableFile(file.stream);
}

// Admin side: upload, manage and view any tribe's invoices.
@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @Throttle(UPLOAD_THROTTLE)
  @pdfUpload()
  create(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateInvoiceDto,
    @CurrentUserId() userId: string,
  ) {
    return this.invoices.create(dto, file, userId);
  }

  @Get()
  list(@Query('coachId') coachId?: string) {
    return this.invoices.list(coachId || undefined);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoices.update(id, dto);
  }

  @Put(':id/file')
  @Throttle(UPLOAD_THROTTLE)
  @pdfUpload()
  replaceFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.invoices.replaceFile(id, file);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string) {
    return this.invoices.remove(id);
  }

  @Get(':id/file')
  async file(
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.invoices.openForAdmin(id);
    return sendPdf(res, file, wantsDownload(download));
  }
}

// Tribe side. Always the caller's own tribe (from the session).
@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TRIBE)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    return this.invoices.listForTribe(
      await this.invoices.tribeIdForUser(userId),
    );
  }

  @Get(':id/file')
  async file(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const tribeId = await this.invoices.tribeIdForUser(userId);
    const file = await this.invoices.openForTribe(tribeId, id);
    return sendPdf(res, file, wantsDownload(download));
  }
}
