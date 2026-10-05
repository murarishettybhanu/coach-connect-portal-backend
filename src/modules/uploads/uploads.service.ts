import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { Readable } from 'stream';

/** A private object read back from the bucket, ready to stream. */
export interface PrivateObject {
  stream: Readable;
  contentLength?: number;
}

/** Only ObjectId-shaped owner ids reach a private key (no path tricks). */
const OWNER_ID = /^[a-f0-9]{24}$/i;
/** Private keys this service writes: `invoices/<ownerId>/<32 hex>.pdf`. */
const PRIVATE_PDF_KEY = /^invoices\/[a-f0-9]{24}\/[a-f0-9]{32}\.pdf$/i;

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
 * Uploads images to S3 (public) and stores private objects (invoice PDFs —
 * never given a URL, see the private-object helpers). Configured via env:
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
        'S3 not configured (S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — image and invoice uploads disabled.',
      );
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException('File uploads are not configured.');
    }
    return this.client;
  }

  // ── Private objects (invoices) ────────────────────────────────────────────
  // Same bucket and credentials as the public images, but these keys are never
  // turned into a URL: they are read back only through an authenticated
  // endpoint that checks ownership. Callers validate the bytes first.

  /**
   * Stores a PDF under `invoices/<ownerId>/<random 32-hex>.pdf` and returns
   * the key. Nothing here builds a public URL.
   */
  async putPrivatePdf(ownerId: string, body: Buffer): Promise<string> {
    const client = this.requireClient();
    if (!OWNER_ID.test(ownerId)) {
      throw new BadRequestException('Invalid owner id');
    }
    const key = `invoices/${ownerId.toLowerCase()}/${crypto.randomBytes(16).toString('hex')}.pdf`;
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/pdf',
          ContentLength: body.length,
          CacheControl: 'private, no-store',
        }),
      );
    } catch (err) {
      this.rethrowAccessDenied(err, 'write');
      throw err;
    }
    return key;
  }

  /**
   * The S3 user has no rights on `invoices/*` (its IAM policy predates
   * invoices) — say so plainly instead of a bare 500, and log the fix.
   */
  private rethrowAccessDenied(err: unknown, action: 'write' | 'read'): void {
    if ((err as { name?: string })?.name !== 'AccessDenied') return;
    this.logger.error(
      `S3 denied ${action} on invoices/*: grant the uploader s3:PutObject, ` +
        's3:GetObject and s3:DeleteObject on <bucket>/invoices/*',
    );
    throw new ServiceUnavailableException(
      'Invoice storage is not set up yet (missing S3 permission). Contact the administrator.',
    );
  }

  /** Opens a private object as a stream (404 if it isn't there). */
  async getPrivateObject(key: string): Promise<PrivateObject> {
    const client = this.requireClient();
    if (!PRIVATE_PDF_KEY.test(key))
      throw new NotFoundException('File not found');
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!out.Body) throw new NotFoundException('File not found');
      return {
        stream: out.Body as Readable,
        contentLength:
          typeof out.ContentLength === 'number' ? out.ContentLength : undefined,
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundException('File not found');
      }
      this.rethrowAccessDenied(err, 'read');
      throw err;
    }
  }

  /**
   * Deletes a private object, best-effort: a failure is logged and swallowed
   * (an orphaned object is harmless; failing the caller's write isn't).
   * Returns whether the delete went through.
   */
  async deletePrivateObject(key: string | null | undefined): Promise<boolean> {
    if (!key || !this.client || !PRIVATE_PDF_KEY.test(key)) return false;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `Could not delete private object ${key}: ${(err as Error)?.message ?? err}`,
      );
      return false;
    }
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
