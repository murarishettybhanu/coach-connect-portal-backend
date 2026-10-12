import {
  checkOutboundMedia,
  mediaPreview,
  sanitizeFilename,
} from './outbound-media';

const MB = 1024 * 1024;

describe('checkOutboundMedia', () => {
  it.each([
    ['image/jpeg', 'a.jpg', 'image'],
    ['image/png', 'a.png', 'image'],
    ['video/mp4', 'a.mp4', 'video'],
    ['audio/mpeg', 'a.mp3', 'audio'],
    ['application/pdf', 'a.pdf', 'document'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'a.xlsx',
      'document',
    ],
    ['text/csv', 'a.csv', 'document'],
  ])('%s → %s', (mimetype, originalname, kind) => {
    const r = checkOutboundMedia({ mimetype, originalname, size: 1000 });
    expect(r).toMatchObject({ ok: true, kind, mimeType: mimetype });
  });

  it('falls back to the extension when the browser sends no or a generic type', () => {
    expect(
      checkOutboundMedia({ mimetype: '', originalname: 'list.csv', size: 10 }),
    ).toMatchObject({
      ok: true,
      kind: 'document',
      mimeType: 'text/csv',
    });
    expect(
      checkOutboundMedia({
        mimetype: 'application/octet-stream',
        originalname: 'v.AMR',
        size: 10,
      }),
    ).toMatchObject({ ok: true, kind: 'audio', mimeType: 'audio/amr' });
  });

  it('rejects types WhatsApp cannot send', () => {
    for (const [mimetype, originalname] of [
      ['image/gif', 'a.gif'],
      ['image/webp', 'a.webp'],
      ['application/zip', 'a.zip'],
      ['application/x-msdownload', 'a.exe'],
    ]) {
      const r = checkOutboundMedia({ mimetype, originalname, size: 10 });
      expect(r.ok).toBe(false);
    }
  });

  it('applies per-kind size limits', () => {
    expect(
      checkOutboundMedia({
        mimetype: 'image/png',
        originalname: 'a.png',
        size: 5 * MB,
      }).ok,
    ).toBe(true);
    const big = checkOutboundMedia({
      mimetype: 'image/png',
      originalname: 'a.png',
      size: 5 * MB + 1,
    });
    expect(big).toEqual({
      ok: false,
      error: 'Images must be 5 MB or smaller for WhatsApp.',
    });
    expect(
      checkOutboundMedia({
        mimetype: 'application/pdf',
        originalname: 'a.pdf',
        size: 17 * MB,
      }).ok,
    ).toBe(false);
    expect(
      checkOutboundMedia({
        mimetype: 'application/pdf',
        originalname: 'a.pdf',
        size: 0,
      }).ok,
    ).toBe(false);
  });
});

describe('sanitizeFilename / mediaPreview', () => {
  it('strips paths and unsafe characters', () => {
    expect(sanitizeFilename('C:\\Users\\me\\"Invoice"<1>.pdf')).toBe(
      'Invoice1.pdf',
    );
    expect(sanitizeFilename('')).toBe('file');
  });
  it('previews the caption, else the filename or kind', () => {
    expect(mediaPreview('document', 'Invoice.pdf')).toBe('📎 Invoice.pdf');
    expect(mediaPreview('image', 'a.jpg')).toBe('📷 Photo');
    expect(mediaPreview('image', 'a.jpg', 'Your kit')).toBe('📷 Your kit');
  });
});
