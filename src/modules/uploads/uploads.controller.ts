import {
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // Public: also used by the storefront/claim/checkout flows (unauthenticated
  // customers uploading a custom photo). Strictly validated: images only, ≤5MB.
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) cb(null, true);
        else cb(new BadRequestException('Only image files are allowed'), false);
      },
    }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query('category') category?: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const url = await this.uploads.uploadImage(file, category || 'misc');
    return { url };
  }
}
