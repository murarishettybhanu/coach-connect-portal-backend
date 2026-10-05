import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { UploadsService, detectImageType } from './uploads.service';

// Smallest real headers for each format, padded to a plausible length.
const pad = (head: number[] | Buffer) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = pad(Buffer.from('GIF89a'));
const WEBP = pad(
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WEBP'),
  ]),
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = Buffer.from(
  '<!doctype html><script>alert(document.cookie)</script>',
);

describe('detectImageType', () => {
  it.each([
    ['JPEG', JPEG, 'jpg', 'image/jpeg'],
    ['PNG', PNG, 'png', 'image/png'],
    ['GIF', GIF, 'gif', 'image/gif'],
    ['WebP', WEBP, 'webp', 'image/webp'],
  ])('recognises %s from its bytes', (_name, buf, ext, contentType) => {
    expect(detectImageType(buf)).toEqual({ ext, contentType });
  });

  it.each([
    ['SVG', SVG],
    ['HTML', HTML],
    ['empty', Buffer.alloc(0)],
    ['RIFF that is not WebP (WAV)', pad(Buffer.from('RIFF\0\0\0\0WAVE'))],
  ])('rejects %s', (_name, buf) => {
    expect(detectImageType(buf)).toBeNull();
  });
});

describe('UploadsService.uploadImage', () => {
  const config = {
    get: (key: string) =>
      ({
        S3_BUCKET: 'bucket',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      })[key],
  } as unknown as ConfigService;

  let service: UploadsService;
  let send: jest.Mock;

  beforeEach(() => {
    service = new UploadsService(config);
    send = jest.fn().mockResolvedValue({});
    (service as unknown as { client: { send: jest.Mock } }).client = { send };
  });

  it('derives the extension and Content-Type from the bytes, not the client', async () => {
    // A real PNG the client mislabelled as a JPEG named .exe.
    const url = await service.uploadImage(
      { originalname: 'photo.exe', mimetype: 'image/jpeg', buffer: PNG },
      'claims',
    );

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.ContentType).toBe('image/png');
    expect(command.input.Key).toMatch(/^uploads\/claims\/.+\.png$/);
    expect(url).toMatch(/\.png$/);
  });

  it('refuses an SVG, whatever it claims to be', async () => {
    await expect(
      service.uploadImage({
        originalname: 'logo.png',
        mimetype: 'image/png',
        buffer: SVG,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses HTML dressed up as a PNG', async () => {
    await expect(
      service.uploadImage({
        originalname: 'photo.png',
        mimetype: 'image/png',
        buffer: HTML,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });
});

// The S3 client is always replaced by a mock — these never reach AWS.
describe('UploadsService private objects (invoices)', () => {
  const config = {
    get: (key: string) =>
      ({
        S3_BUCKET: 'bucket',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
      })[key],
  } as unknown as ConfigService;
  const OWNER = '64b7f0c2a1b2c3d4e5f60718';
  const KEY = `invoices/${OWNER}/${'c'.repeat(32)}.pdf`;
  const PDF = Buffer.from('%PDF-1.7 test');

  let service: UploadsService;
  let send: jest.Mock;

  beforeEach(() => {
    service = new UploadsService(config);
    send = jest.fn().mockResolvedValue({});
    (service as unknown as { client: { send: jest.Mock } }).client = { send };
  });

  it('turns an S3 permission error into a clear 503 (write and read)', async () => {
    const denied = Object.assign(new Error('not authorized'), {
      name: 'AccessDenied',
    });
    send.mockRejectedValue(denied);
    await expect(service.putPrivatePdf(OWNER, PDF)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('Invoice storage is not set up'),
    });
    await expect(
      service.getPrivateObject(`invoices/${OWNER}/${'a'.repeat(32)}.pdf`),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('puts the PDF under invoices/<owner>/<32 hex>.pdf and returns only the key', async () => {
    const key = await service.putPrivatePdf(OWNER, PDF);
    expect(key).toMatch(new RegExp(`^invoices/${OWNER}/[a-f0-9]{32}\\.pdf$`));
    expect(key).not.toContain('https://');
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'bucket',
      Key: key,
      ContentType: 'application/pdf',
      CacheControl: 'private, no-store',
    });
    expect(cmd.input.ACL).toBeUndefined();
  });

  it('two uploads never share a key', async () => {
    const a = await service.putPrivatePdf(OWNER, PDF);
    const b = await service.putPrivatePdf(OWNER, PDF);
    expect(a).not.toBe(b);
  });

  it('refuses an owner id that could escape the prefix', async () => {
    await expect(
      service.putPrivatePdf('../uploads', PDF),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('streams an object back', async () => {
    const body = Readable.from([PDF]);
    send.mockResolvedValueOnce({ Body: body, ContentLength: PDF.length });
    const out = await service.getPrivateObject(KEY);
    expect(out).toEqual({ stream: body, contentLength: PDF.length });
    const cmd = send.mock.calls[0][0] as GetObjectCommand;
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'bucket', Key: KEY });
  });

  it('404s a missing object or a key outside invoices/', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'NoSuchKey' }),
    );
    await expect(service.getPrivateObject(KEY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    send.mockClear();
    await expect(
      service.getPrivateObject('uploads/claims/x.png'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes best-effort: failures are swallowed', async () => {
    await expect(service.deletePrivateObject(KEY)).resolves.toBe(true);
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(service.deletePrivateObject(KEY)).resolves.toBe(false);
    await expect(service.deletePrivateObject(undefined)).resolves.toBe(false);
    await expect(
      service.deletePrivateObject('uploads/claims/x.png'),
    ).resolves.toBe(false);
  });

  it('503s put/get when S3 is not configured', async () => {
    const off = new UploadsService({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(off.isConfigured()).toBe(false);
    await expect(off.putPrivatePdf(OWNER, PDF)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(off.getPrivateObject(KEY)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(off.deletePrivateObject(KEY)).resolves.toBe(false);
  });
});
