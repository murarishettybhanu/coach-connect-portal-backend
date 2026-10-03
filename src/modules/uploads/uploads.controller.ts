import {
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // Public: also used by the storefront/claim/checkout flows (unauthenticated
  // customers uploading a custom photo). Strictly validated: JPEG/PNG/WebP/GIF
  // only, ≤5MB, and the type is read from the file's bytes, not the client's
  // claim. Throttled hard — every upload is a public object in our bucket.
  @Post('image')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      // A cheap early reject of obvious non-images, before buffering them.
      // Not trusted: the service checks the real bytes.
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
