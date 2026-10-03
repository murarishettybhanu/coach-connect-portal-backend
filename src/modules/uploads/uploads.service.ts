import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';

export interface DetectedImage {
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/**
 * Identifies an image by its leading bytes ("magic numbers"). Only the four
 * raster formats browsers render safely are recognised — SVG deliberately is
 * not: it is XML that can carry script, and these files are served publicly.
 * Returns null for anything else, whatever its name or claimed type.
 */
export function detectImageType(buf: Buffer): DetectedImage | null {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  // GIF: "GIF87a" / "GIF89a"
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  // WebP: "RIFF" <size> "WEBP"
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

/**
 * Uploads images to S3. Configured via env:
 *   AWS_REGION (default ap-south-1), S3_BUCKET,
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 *   S3_PUBLIC_BASE_URL (optional; defaults to the bucket's virtual-hosted URL)
 * If unconfigured, uploads throw a clear 503 (the UI falls back gracefully).
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private client: S3Client | null = null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicBase: string;

  constructor(private readonly config: ConfigService) {
    this.region = this.config.get<string>('AWS_REGION') || 'ap-south-1';
    this.bucket = this.config.get<string>('S3_BUCKET') || '';
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');
    this.publicBase =
      this.config.get<string>('S3_PUBLIC_BASE_URL') ||
      `https://${this.bucket}.s3.${this.region}.amazonaws.com`;

    if (this.bucket && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: this.region,
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.logger.warn(
        'S3 not configured (S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — image uploads disabled.',
      );
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async uploadImage(
    file: { originalname: string; mimetype: string; buffer: Buffer },
    category = 'misc',
  ): Promise<string> {
    // The client's filename and mimetype are ignored: both are whatever the
    // uploader says. Extension and Content-Type come from the bytes, so a
    // page saved as "photo.png" can't be served back as HTML or SVG.
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw new BadRequestException(
        'Only JPEG, PNG, WebP or GIF images are allowed',
      );
    }
    if (!this.client) {
      throw new ServiceUnavailableException('File uploads are not configured.');
    }
    const { ext, contentType } = detected;
    const safeCat =
      category.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'misc';
    const key = `uploads/${safeCat}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.publicBase.replace(/\/$/, '')}/${key}`;
  }
}
