import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';

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
    if (!this.client) {
      throw new ServiceUnavailableException('File uploads are not configured.');
    }
    const ext =
      (file.originalname.split('.').pop() || 'jpg')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '') || 'jpg';
    const safeCat = category.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'misc';
    const key = `uploads/${safeCat}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.publicBase.replace(/\/$/, '')}/${key}`;
  }
}
