import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand } from '@aws-sdk/client-s3';
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
