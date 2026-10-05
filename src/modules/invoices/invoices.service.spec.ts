import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Readable } from 'stream';
import request from 'supertest';
import { configureApp } from '../../app.setup';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../schemas/user.schema';
import { InvoicesService, toInvoiceResponse } from './invoices.service';
import {
  AdminInvoicesController,
  InvoicesController,
} from './invoices.controller';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import {
  MAX_INVOICE_PDF_BYTES,
  cleanOriginalName,
  contentDisposition,
  invoiceDownloadName,
  isPdf,
} from './invoice-file';

// ── An in-memory stand-in for the TribeInvoice model ─────────────────────────
// Just enough of Mongoose's query API for the service: filters on plain
// equality plus `$exists`, `.select('+fileKey')` and `fileKey` hidden
// otherwise (the schema's `select: false`), sort by invoiceDate desc.

const oid = () => new Types.ObjectId();
const TRIBE = String(oid());
const OTHER_TRIBE = String(oid());
const ADMIN = String(oid());
const TRIBE_USER = String(oid());
const OTHER_USER = String(oid());

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.alloc(64, 0x20),
  Buffer.from('%%EOF'),
]);
const pdfFile = (name = 'INV-1.pdf', buffer = PDF) => ({
  originalname: name,
  mimetype: 'application/pdf',
  buffer,
  size: buffer.length,
});

const matches = (doc: any, filter: any) =>
  Object.entries(filter).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && '$exists' in v) {
      return v.$exists ? doc[k] !== undefined : doc[k] === undefined;
    }
    return String(doc[k]) === String(v);
  });

function fakeModel(rows: any[]) {
  const query = (resolve: () => any) => {
    let withKey = false;
    let sorted = false;
    const shape = (d: any) => {
      if (!d) return d;
      const copy = { ...d };
      if (!withKey) delete copy.fileKey;
      return copy;
    };
    const q: any = {
      select: (s: string) => {
        if (String(s).includes('+fileKey')) withKey = true;
        return q;
      },
      sort: () => {
        sorted = true;
        return q;
      },
      populate: jest.fn(() => q),
      lean: () => q,
      exec: async () => {
        const v = resolve();
        if (Array.isArray(v)) {
          const out = sorted
            ? [...v].sort((a, b) => +b.invoiceDate - +a.invoiceDate)
            : v;
          return out.map(shape);
        }
        return shape(v);
      },
    };
    return q;
  };
  const apply = (doc: any, change: any) => {
    Object.assign(doc, change.$set ?? {});
    for (const k of Object.keys(change.$unset ?? {})) delete doc[k];
    doc.updatedAt = new Date();
  };
  const model: any = {
    rows,
    find: jest.fn((f: any) => query(() => rows.filter((r) => matches(r, f)))),
    findOne: jest.fn((f: any) =>
      query(() => rows.find((r) => matches(r, f)) ?? null),
    ),
    findOneAndUpdate: jest.fn((f: any, change: any) =>
      query(() => {
        const doc = rows.find((r) => matches(r, f));
        if (!doc) return null;
        apply(doc, change);
        return doc;
      }),
    ),
    updateOne: jest.fn((f: any, change: any) => ({
      exec: async () => {
        const doc = rows.find((r) => matches(r, f));
        if (doc) Object.assign(doc, change.$set);
        return { modifiedCount: doc ? 1 : 0 };
      },
    })),
    create: jest.fn(async (doc: any) => {
      // The partial unique index: { coachId, invoiceNumber } among live rows.
      if (
        rows.some(
          (r) =>
            !r.isDeleted &&
            String(r.coachId) === String(doc.coachId) &&
            r.invoiceNumber === doc.invoiceNumber,
        )
      ) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const row = {
        _id: oid(),
        ...doc,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return { toObject: () => ({ ...row }) };
    }),
  };
  return model;
}

function setup(opts: { configured?: boolean; rows?: any[] } = {}) {
  const invoices = fakeModel(opts.rows ?? []);
  const tribes = {
    findOne: jest.fn((f: any) => ({
      select: () => ({
        lean: () => ({
          exec: async () =>
            f.userId === TRIBE_USER
              ? { _id: TRIBE }
              : f.userId === OTHER_USER
                ? { _id: OTHER_TRIBE }
                : null,
        }),
      }),
    })),
    findById: jest.fn((id: string) => ({
      select: () => ({
        lean: () => ({
          exec: async () =>
            [TRIBE, OTHER_TRIBE].includes(String(id)) ? { _id: id } : null,
        }),
      }),
    })),
  };
  let n = 0;
  const uploads = {
    isConfigured: jest.fn(() => opts.configured ?? true),
    putPrivatePdf: jest.fn(
      async (owner: string) =>
        `invoices/${owner}/${String(++n).padStart(32, '0')}.pdf`,
    ),
    getPrivateObject: jest.fn(async () => ({
      stream: Readable.from([PDF]),
      contentLength: PDF.length,
    })),
    deletePrivateObject: jest.fn(async () => true),
  };
  const service = new InvoicesService(
    invoices as any,
    tribes as any,
    uploads as any,
  );
  return { service, invoices, tribes, uploads };
}

const today = () => new Date().toISOString().slice(0, 10);
const dto = (over: Partial<CreateInvoiceDto> = {}): CreateInvoiceDto => ({
  coachId: TRIBE,
  invoiceNumber: 'INV-001',
  invoiceDate: today(),
  amount: 1499.5,
  ...over,
});

const row = (over: any = {}) => ({
  _id: oid(),
  coachId: TRIBE,
  invoiceNumber: `INV-${Math.random().toString(36).slice(2, 8)}`,
  invoiceDate: new Date('2026-09-01'),
  amount: 100,
  fileKey: `invoices/${TRIBE}/${'a'.repeat(32)}.pdf`,
  fileName: 'x.pdf',
  fileSize: 10,
  isDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const noFileKey = (value: unknown) =>
  expect(JSON.stringify(value)).not.toContain('fileKey');

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('invoice file helpers', () => {
  it('recognises a PDF by its bytes only', () => {
    expect(isPdf(PDF)).toBe(true);
    expect(isPdf(Buffer.from('<html>%PDF-</html>'))).toBe(false);
    expect(isPdf(Buffer.from('%PDF'))).toBe(false);
    expect(isPdf(Buffer.alloc(0))).toBe(false);
    expect(isPdf(undefined)).toBe(false);
  });

  it.each([
    ['INV-001', 'INV-001.pdf'],
    ['INV/2026/07', 'INV_2026_07.pdf'],
    ['../../etc/passwd', 'etc_passwd.pdf'],
    ['a"b\r\nSet-Cookie: x=1', 'a_b_Set-Cookie_x_1.pdf'],
    ['  TM 2026 / 15 ', 'TM_2026_15.pdf'],
    ['चालान-7', '7.pdf'],
    ['...', 'invoice.pdf'],
    ['', 'invoice.pdf'],
  ])('sanitises %j → %s', (input, out) => {
    expect(invoiceDownloadName(input)).toBe(out);
  });

  it('caps the name length', () => {
    expect(invoiceDownloadName('x'.repeat(500))).toBe(`${'x'.repeat(100)}.pdf`);
  });

  it('builds inline / attachment dispositions', () => {
    expect(contentDisposition('INV/1', false)).toBe(
      'inline; filename="INV_1.pdf"',
    );
    expect(contentDisposition('INV/1', true)).toBe(
      'attachment; filename="INV_1.pdf"',
    );
  });

  it('keeps only the base of the original name, without control chars', () => {
    expect(cleanOriginalName('C:\\Users\\me\\Inv\u0000 7.pdf')).toBe(
      'Inv 7.pdf',
    );
    expect(cleanOriginalName('')).toBe('invoice.pdf');
  });
});

// ── DTO validation ───────────────────────────────────────────────────────────

describe('invoice DTOs', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const create = (body: any) =>
    pipe.transform(body, { type: 'body', metatype: CreateInvoiceDto });
  const update = (body: any) =>
    pipe.transform(body, { type: 'body', metatype: UpdateInvoiceDto });
  const form = (over: any = {}) => ({
    coachId: TRIBE,
    invoiceNumber: ' INV-9 ',
    invoiceDate: '2026-10-01',
    amount: '1499.50',
    reference: '',
    ...over,
  });

  it('accepts multipart strings, trims, converts the amount', async () => {
    const out = await create(form({ note: ' thanks ' }));
    expect(out).toMatchObject({
      invoiceNumber: 'INV-9',
      amount: 1499.5,
      note: 'thanks',
    });
    expect(out.reference).toBeUndefined();
  });

  it.each([
    ['negative amount', { amount: '-1' }],
    ['3 decimals', { amount: '10.123' }],
    ['empty amount', { amount: '' }],
    ['non-numeric amount', { amount: 'ten' }],
    ['bad date', { invoiceDate: '05/10/2026' }],
    ['bad tribe id', { coachId: 'abc' }],
    ['blank number', { invoiceNumber: '   ' }],
    ['long reference', { reference: 'r'.repeat(121) }],
    ['long note', { note: 'n'.repeat(501) }],
    ['unknown field', { fileKey: 'invoices/x' }],
  ])('rejects %s', async (_n, over) => {
    await expect(create(form(over))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('PATCH takes any subset; null or "" clears reference/note', async () => {
    expect(await update({ amount: 5 })).toMatchObject({ amount: 5 });
    expect(await update({ reference: '', note: null })).toMatchObject({
      reference: null,
      note: null,
    });
    await expect(update({ coachId: TRIBE })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ── Service ──────────────────────────────────────────────────────────────────

describe('InvoicesService.create', () => {
  it('stores the PDF privately and returns the invoice without fileKey', async () => {
    const { service, invoices, uploads } = setup();
    const out = await service.create(dto(), pdfFile('My Invoice.pdf'), ADMIN);
    expect(uploads.putPrivatePdf).toHaveBeenCalledWith(TRIBE, PDF);
    expect(invoices.rows[0].fileKey).toMatch(/^invoices\//);
    expect(out).toMatchObject({
      coachId: TRIBE,
      invoiceNumber: 'INV-001',
      amount: 1499.5,
      fileName: 'My Invoice.pdf',
      fileSize: PDF.length,
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        '_id',
        'coachId',
        'invoiceNumber',
        'invoiceDate',
        'amount',
        'fileName',
        'fileSize',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    noFileKey(out);
  });

  it('400s non-PDF bytes renamed .pdf (whatever the mimetype)', async () => {
    const { service, uploads } = setup();
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    await expect(
      service.create(dto(), pdfFile('invoice.pdf', html), ADMIN),
    ).rejects.toThrow(new BadRequestException('Only PDF files are allowed'));
    expect(uploads.putPrivatePdf).not.toHaveBeenCalled();
  });

  it('400s a PDF over 10 MB', async () => {
    const { service } = setup();
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_INVOICE_PDF_BYTES)]);
    await expect(
      service.create(dto(), pdfFile('big.pdf', big), ADMIN),
    ).rejects.toThrow(new BadRequestException('PDF must be 10 MB or smaller'));
  });

  it('400s a missing file', async () => {
    const { service } = setup();
    await expect(service.create(dto(), undefined, ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('503s when S3 is not configured', async () => {
    const { service, uploads } = setup({ configured: false });
    await expect(service.create(dto(), pdfFile(), ADMIN)).rejects.toThrow(
      new ServiceUnavailableException('File uploads are not configured.'),
    );
    expect(uploads.putPrivatePdf).not.toHaveBeenCalled();
  });

  it('404s an unknown tribe', async () => {
    const { service } = setup();
    await expect(
      service.create(dto({ coachId: String(oid()) }), pdfFile(), ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s a date more than 31 days ahead', async () => {
    const { service } = setup();
    const far = new Date(Date.now() + 40 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await expect(
      service.create(dto({ invoiceDate: far }), pdfFile(), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    const near = new Date(Date.now() + 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await expect(
      service.create(dto({ invoiceDate: near }), pdfFile(), ADMIN),
    ).resolves.toBeDefined();
  });

  it('409s a number already used by this tribe, before uploading', async () => {
    const { service, uploads } = setup();
    await service.create(dto(), pdfFile(), ADMIN);
    uploads.putPrivatePdf.mockClear();
    await expect(service.create(dto(), pdfFile(), ADMIN)).rejects.toThrow(
      new ConflictException('Invoice number already exists for this tribe'),
    );
    expect(uploads.putPrivatePdf).not.toHaveBeenCalled();
  });

  it('allows the same number for another tribe', async () => {
    const { service } = setup();
    await service.create(dto(), pdfFile(), ADMIN);
    await expect(
      service.create(dto({ coachId: OTHER_TRIBE }), pdfFile(), ADMIN),
    ).resolves.toMatchObject({ coachId: OTHER_TRIBE });
  });

  it('allows the number again after a soft delete', async () => {
    const { service } = setup();
    const first = await service.create(dto(), pdfFile(), ADMIN);
    await service.remove(String(first._id));
    await expect(
      service.create(dto(), pdfFile(), ADMIN),
    ).resolves.toMatchObject({ invoiceNumber: 'INV-001' });
  });

  it('a race lost on the unique index → 409 and the new object is removed', async () => {
    const { service, invoices, uploads } = setup();
    // The pre-check sees nothing; the insert then hits the index.
    invoices.rows.push(row({ invoiceNumber: 'INV-001' }));
    invoices.findOne.mockImplementationOnce(() => ({
      select: () => ({ lean: () => ({ exec: async () => null }) }),
    }));
    await expect(service.create(dto(), pdfFile(), ADMIN)).rejects.toThrow(
      ConflictException,
    );
    const key = await uploads.putPrivatePdf.mock.results[0].value;
    expect(uploads.deletePrivateObject).toHaveBeenCalledWith(key);
  });
});

describe('InvoicesService admin list / update / replace / delete', () => {
  it('lists live invoices newest first; populates the tribe only for all-tribes', async () => {
    const old = row({ invoiceDate: new Date('2026-01-01') });
    const recent = row({ invoiceDate: new Date('2026-09-01') });
    const other = row({ coachId: OTHER_TRIBE });
    const gone = row({ isDeleted: true });
    const { service, invoices } = setup({ rows: [old, recent, other, gone] });

    const mine = await service.list(TRIBE);
    expect(mine.map((i) => i._id)).toEqual([recent._id, old._id]);
    noFileKey(mine);

    const all = await service.list();
    expect(all).toHaveLength(3);
    const lastQuery = invoices.find.mock.results.at(-1).value;
    expect(lastQuery.populate).toHaveBeenCalledWith({
      path: 'coachId',
      select: 'username brand name',
    });
    noFileKey(all);
  });

  it('400s a malformed coachId filter', async () => {
    const { service } = setup();
    await expect(service.list('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('updates metadata, clears reference with null, 409s a taken number', async () => {
    const a = row({ invoiceNumber: 'A', reference: 'PO-1' });
    const b = row({ invoiceNumber: 'B' });
    const { service } = setup({ rows: [a, b] });

    const out = await service.update(String(a._id), {
      amount: 250.25,
      reference: null,
      note: 'Paid',
    });
    expect(out).toMatchObject({ amount: 250.25, note: 'Paid' });
    expect(out.reference).toBeUndefined();
    noFileKey(out);

    await expect(
      service.update(String(a._id), { invoiceNumber: 'B' }),
    ).rejects.toThrow(
      new ConflictException('Invoice number already exists for this tribe'),
    );
    // Its own number is not a conflict.
    await expect(
      service.update(String(a._id), { invoiceNumber: 'A' }),
    ).resolves.toBeDefined();
  });

  it('404s updating a deleted or unknown invoice', async () => {
    const gone = row({ isDeleted: true });
    const { service } = setup({ rows: [gone] });
    await expect(
      service.update(String(gone._id), { amount: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('bad', { amount: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replacing the PDF resets viewedAt and deletes the old object', async () => {
    const oldKey = `invoices/${TRIBE}/${'b'.repeat(32)}.pdf`;
    const inv = row({ fileKey: oldKey, viewedAt: new Date() });
    const { service, uploads, invoices } = setup({ rows: [inv] });

    const out = await service.replaceFile(String(inv._id), pdfFile('v2.pdf'));
    expect(out.viewedAt).toBeUndefined();
    expect(out).toMatchObject({ fileName: 'v2.pdf' });
    noFileKey(out);
    expect(invoices.rows[0].fileKey).not.toBe(oldKey);
    expect(uploads.deletePrivateObject).toHaveBeenCalledWith(oldKey);
  });

  it('replacing still succeeds when deleting the old object fails', async () => {
    const inv = row();
    const { service, uploads } = setup({ rows: [inv] });
    // Best-effort: the real helper swallows and returns false.
    uploads.deletePrivateObject.mockResolvedValueOnce(false);
    await expect(
      service.replaceFile(String(inv._id), pdfFile()),
    ).resolves.toBeDefined();
  });

  it('replace validates the file and S3 like create', async () => {
    const inv = row();
    const { service } = setup({ rows: [inv] });
    await expect(
      service.replaceFile(String(inv._id), pdfFile('x.pdf', Buffer.from('MZ'))),
    ).rejects.toThrow('Only PDF files are allowed');
    const off = setup({ rows: [row()], configured: false });
    await expect(
      off.service.replaceFile(String(off.invoices.rows[0]._id), pdfFile()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('soft delete hides it, deletes the object, and 404s a second time', async () => {
    const inv = row();
    const { service, uploads, invoices } = setup({ rows: [inv] });
    await expect(service.remove(String(inv._id))).resolves.toEqual({
      success: true,
    });
    expect(invoices.rows[0]).toMatchObject({ isDeleted: true });
    expect(invoices.rows[0].deletedAt).toBeInstanceOf(Date);
    expect(uploads.deletePrivateObject).toHaveBeenCalledWith(inv.fileKey);
    expect(await service.list(TRIBE)).toEqual([]);
    expect((await service.listForTribe(TRIBE)).invoices).toEqual([]);
    await expect(
      service.openForTribe(TRIBE, String(inv._id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(String(inv._id))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin can open any live invoice without marking it viewed', async () => {
    const inv = row();
    const { service, uploads, invoices } = setup({ rows: [inv] });
    const file = await service.openForAdmin(String(inv._id));
    expect(file.invoiceNumber).toBe(inv.invoiceNumber);
    expect(uploads.getPrivateObject).toHaveBeenCalledWith(inv.fileKey);
    expect(invoices.rows[0].viewedAt).toBeUndefined();
  });
});

describe('InvoicesService tribe side', () => {
  it('lists only the tribe’s live invoices with the unviewed count', async () => {
    const seen = row({ viewedAt: new Date() });
    const fresh1 = row();
    const fresh2 = row({ invoiceDate: new Date('2026-09-30') });
    const others = row({ coachId: OTHER_TRIBE });
    const gone = row({ isDeleted: true });
    const { service } = setup({ rows: [seen, fresh1, fresh2, others, gone] });

    const out = await service.listForTribe(TRIBE);
    expect(out.unviewed).toBe(2);
    expect(out.invoices.map((i) => i._id)).toEqual([
      fresh2._id,
      seen._id,
      fresh1._id,
    ]);
    noFileKey(out);
  });

  it('opens its own invoice and sets viewedAt once', async () => {
    const inv = row();
    const { service, invoices } = setup({ rows: [inv] });
    await service.openForTribe(TRIBE, String(inv._id));
    const first = invoices.rows[0].viewedAt;
    expect(first).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 5));
    await service.openForTribe(TRIBE, String(inv._id));
    expect(invoices.rows[0].viewedAt).toBe(first);
    expect((await service.listForTribe(TRIBE)).unviewed).toBe(0);
  });

  it('404s another tribe’s invoice and leaves it unviewed', async () => {
    const theirs = row({ coachId: OTHER_TRIBE });
    const { service, invoices, uploads } = setup({ rows: [theirs] });
    await expect(
      service.openForTribe(TRIBE, String(theirs._id)),
    ).rejects.toThrow(new NotFoundException('Invoice not found'));
    expect(uploads.getPrivateObject).not.toHaveBeenCalled();
    expect(invoices.rows[0].viewedAt).toBeUndefined();
  });

  it('404s a malformed id', async () => {
    const { service } = setup();
    await expect(service.openForTribe(TRIBE, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not mark viewed when the object can’t be read', async () => {
    const inv = row();
    const { service, invoices, uploads } = setup({ rows: [inv] });
    uploads.getPrivateObject.mockRejectedValueOnce(
      new NotFoundException('File not found'),
    );
    await expect(
      service.openForTribe(TRIBE, String(inv._id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(invoices.rows[0].viewedAt).toBeUndefined();
  });

  it('404s a TRIBE user with no tribe', async () => {
    const { service } = setup();
    await expect(service.tribeIdForUser(String(oid()))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('toInvoiceResponse', () => {
  it('whitelists the contract fields', () => {
    const out = toInvoiceResponse({
      ...row({ reference: 'PO', note: 'n', viewedAt: new Date() }),
      uploadedBy: oid(),
      __v: 3,
    });
    expect(Object.keys(out)).not.toEqual(
      expect.arrayContaining(['fileKey', 'isDeleted', 'uploadedBy', '__v']),
    );
    expect(out).toMatchObject({ reference: 'PO', note: 'n' });
    noFileKey(out);
  });
});

// ── Roles ────────────────────────────────────────────────────────────────────

describe('invoice roles', () => {
  const allowed = (cls: any, handler: any, role: UserRole) =>
    new RolesGuard(new Reflector()).canActivate({
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as any);

  it.each(['create', 'list', 'update', 'replaceFile', 'remove', 'file'])(
    'admin %s is ADMIN only',
    (name) => {
      const h = (AdminInvoicesController.prototype as any)[name];
      expect(allowed(AdminInvoicesController, h, UserRole.ADMIN)).toBe(true);
      expect(allowed(AdminInvoicesController, h, UserRole.TRIBE)).toBe(false);
      expect(allowed(AdminInvoicesController, h, UserRole.CUSTOMER)).toBe(
        false,
      );
    },
  );

  it.each(['list', 'file'])('tribe %s is TRIBE only', (name) => {
    const h = (InvoicesController.prototype as any)[name];
    expect(allowed(InvoicesController, h, UserRole.TRIBE)).toBe(true);
    expect(allowed(InvoicesController, h, UserRole.ADMIN)).toBe(false);
    expect(allowed(InvoicesController, h, UserRole.CUSTOMER)).toBe(false);
  });
});

// ── HTTP: multer limits, headers, streaming, roles end to end ─────────────────
// The real controllers and service behind the production pipeline
// (configureApp), with the models and S3 faked. The JWT guard is replaced by
// one that reads the role/user from test headers.

describe('invoices over HTTP', () => {
  let app: INestApplication;
  let ctx: ReturnType<typeof setup>;

  beforeAll(async () => {
    ctx = setup();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminInvoicesController, InvoicesController],
      providers: [{ provide: InvoicesService, useValue: ctx.service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (c: ExecutionContext) => {
          const req = c.switchToHttp().getRequest();
          req.user = {
            _id: req.headers['x-user'],
            role: req.headers['x-role'],
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    ctx.invoices.rows.length = 0;
    ctx.uploads.isConfigured.mockReturnValue(true);
  });

  const asAdmin = (r: request.Test) =>
    r.set('x-role', UserRole.ADMIN).set('x-user', ADMIN);
  const asTribe = (r: request.Test, user = TRIBE_USER) =>
    r.set('x-role', UserRole.TRIBE).set('x-user', user);
  const upload = (buffer: Buffer, fields: Record<string, string> = {}) => {
    let r = asAdmin(request(app.getHttpServer()).post('/api/admin/invoices'));
    const all = {
      coachId: TRIBE,
      invoiceNumber: 'INV/2026/7',
      invoiceDate: today(),
      amount: '999.99',
      reference: 'PO-77',
      ...fields,
    };
    for (const [k, v] of Object.entries(all)) r = r.field(k, v);
    return r.attach('file', buffer, {
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
    });
  };

  it('201 with the invoice, no fileKey', async () => {
    const res = await upload(PDF).expect(201);
    expect(res.body).toMatchObject({
      invoiceNumber: 'INV/2026/7',
      amount: 999.99,
      reference: 'PO-77',
      fileName: 'invoice.pdf',
    });
    noFileKey(res.body);
  });

  it('400 "Only PDF files are allowed" for non-PDF bytes named .pdf', async () => {
    const res = await upload(Buffer.from('PK\u0003\u0004 zip')).expect(400);
    expect(res.body.message).toBe('Only PDF files are allowed');
  });

  it('400 "PDF must be 10 MB or smaller" over the multer limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_INVOICE_PDF_BYTES)]);
    const res = await upload(big).expect(400);
    expect(res.body.message).toBe('PDF must be 10 MB or smaller');
  });

  it('400 for a second file part', async () => {
    await upload(PDF).attach('file', PDF, 'two.pdf').expect(400);
  });

  it('503 when S3 is not configured', async () => {
    ctx.uploads.isConfigured.mockReturnValue(false);
    const res = await upload(PDF).expect(503);
    expect(res.body.message).toBe('File uploads are not configured.');
  });

  it('409 on a duplicate number for the tribe', async () => {
    await upload(PDF).expect(201);
    const res = await upload(PDF).expect(409);
    expect(res.body.message).toBe(
      'Invoice number already exists for this tribe',
    );
  });

  it('a TRIBE user can’t upload; an ADMIN can’t use the tribe list', async () => {
    await asTribe(
      request(app.getHttpServer()).post('/api/admin/invoices'),
    ).expect(403);
    await asAdmin(request(app.getHttpServer()).get('/api/invoices')).expect(
      403,
    );
  });

  it('streams the tribe’s own PDF inline / as attachment with a safe name', async () => {
    const created = (await upload(PDF).expect(201)).body;
    const list = await asTribe(
      request(app.getHttpServer()).get('/api/invoices'),
    ).expect(200);
    expect(list.body.unviewed).toBe(1);
    noFileKey(list.body);

    const view = await asTribe(
      request(app.getHttpServer()).get(`/api/invoices/${created._id}/file`),
    )
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(view.headers['content-type']).toBe('application/pdf');
    expect(view.headers['content-disposition']).toBe(
      'inline; filename="INV_2026_7.pdf"',
    );
    expect(view.headers['x-content-type-options']).toBe('nosniff');
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(view.body, PDF)).toBe(0);

    const dl = await asTribe(
      request(app.getHttpServer()).get(
        `/api/invoices/${created._id}/file?download=1`,
      ),
    ).expect(200);
    expect(dl.headers['content-disposition']).toBe(
      'attachment; filename="INV_2026_7.pdf"',
    );

    const after = await asTribe(
      request(app.getHttpServer()).get('/api/invoices'),
    ).expect(200);
    expect(after.body.unviewed).toBe(0);
  });

  it('404 for another tribe’s invoice', async () => {
    const created = (await upload(PDF).expect(201)).body;
    await asTribe(
      request(app.getHttpServer()).get(`/api/invoices/${created._id}/file`),
      OTHER_USER,
    ).expect(404);
  });

  it('admin PATCH / PUT file / DELETE / GET file', async () => {
    const created = (await upload(PDF).expect(201)).body;
    const base = `/api/admin/invoices/${created._id}`;

    const patched = await asAdmin(request(app.getHttpServer()).patch(base))
      .send({ amount: 10, note: 'Updated' })
      .expect(200);
    expect(patched.body).toMatchObject({ amount: 10, note: 'Updated' });

    const replaced = await asAdmin(
      request(app.getHttpServer()).put(`${base}/file`),
    )
      .attach('file', PDF, 'v2.pdf')
      .expect(200);
    expect(replaced.body.fileName).toBe('v2.pdf');
    noFileKey(replaced.body);

    const file = await asAdmin(
      request(app.getHttpServer()).get(`${base}/file?download=1`),
    ).expect(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);

    await asAdmin(request(app.getHttpServer()).delete(base))
      .expect(200)
      .expect({ success: true });
    await asTribe(
      request(app.getHttpServer()).get(`/api/invoices/${created._id}/file`),
    ).expect(404);
  });
});
