// Invoices against a real MongoDB — the per-tribe uniqueness that survives a
// soft delete lives in the partial unique index, which a mocked model can't
// prove. Runs only when MONGO_TEST_URI is set; uses its own database
// (shipkit_invoicetest, dropped afterwards). S3 is always a mock here.
//   MONGO_TEST_URI=mongodb://localhost:27017/shipkit_sizetest npx jest invoices.int
import mongoose, { Model } from 'mongoose';
import { Readable } from 'stream';
import {
  TribeInvoice,
  TribeInvoiceSchema,
} from '../../schemas/tribe-invoice.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { InvoicesService } from './invoices.service';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('invoices (real MongoDB)', () => {
  let conn: mongoose.Connection;
  let invoices: Model<TribeInvoice>;
  let tribes: Model<Tribe>;
  let svc: InvoicesService;
  const tribe = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  const PDF = Buffer.from('%PDF-1.7 int test');
  let n = 0;
  const uploads = {
    isConfigured: () => true,
    putPrivatePdf: jest.fn(
      async (owner: string) =>
        `invoices/${owner}/${String(++n).padStart(32, '0')}.pdf`,
    ),
    getPrivateObject: jest.fn(async () => ({ stream: Readable.from([PDF]) })),
    deletePrivateObject: jest.fn(async () => true),
  };
  const file = () => ({ originalname: 'a.pdf', buffer: PDF });
  const dto = (coachId = tribe, invoiceNumber = 'INV-1') => ({
    coachId: String(coachId),
    invoiceNumber,
    invoiceDate: '2026-10-01',
    amount: 100,
  });

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_invoicetest' })
      .asPromise();
    invoices = conn.model<TribeInvoice>('TribeInvoice', TribeInvoiceSchema);
    tribes = conn.model<Tribe>('Tribe', TribeSchema);
    await invoices.init(); // the partial unique index must exist
    await tribes.collection.insertMany([
      { _id: tribe, userId: new mongoose.Types.ObjectId(), username: 't1' },
      { _id: other, userId: new mongoose.Types.ObjectId(), username: 't2' },
    ]);
    svc = new InvoicesService(invoices, tribes, uploads as any);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  beforeEach(async () => {
    await invoices.deleteMany({});
  });

  it('stores in tribeinvoices with fileKey hidden from normal reads', async () => {
    const created = await svc.create(dto(), file(), '');
    expect(invoices.collection.collectionName).toBe('tribeinvoices');
    const plain = await invoices.findById(created._id).lean();
    expect(plain).not.toHaveProperty('fileKey');
    const raw = await invoices.collection.findOne({ _id: created._id as any });
    expect(raw?.fileKey).toMatch(/^invoices\//);
  });

  it('the index refuses a second live number per tribe, even past the pre-check', async () => {
    await svc.create(dto(), file(), '');
    await expect(
      invoices.create({
        coachId: tribe,
        invoiceNumber: 'INV-1',
        invoiceDate: new Date(),
        amount: 1,
        fileKey: 'k',
        fileName: 'f',
        fileSize: 1,
      } as any),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(svc.create(dto(), file(), '')).rejects.toThrow(
      'Invoice number already exists for this tribe',
    );
    await expect(svc.create(dto(other), file(), '')).resolves.toBeDefined();
  });

  it('a soft-deleted invoice frees its number', async () => {
    const first = await svc.create(dto(), file(), '');
    await svc.remove(String(first._id));
    const again = await svc.create(dto(), file(), '');
    expect(String(again._id)).not.toBe(String(first._id));
    expect(await invoices.countDocuments({ invoiceNumber: 'INV-1' })).toBe(2);
  });

  it('first view sticks; replacing the PDF resets it', async () => {
    const inv = await svc.create(dto(), file(), '');
    await svc.openForTribe(String(tribe), String(inv._id));
    const first = (await invoices.findById(inv._id).lean())!.viewedAt;
    expect(first).toBeInstanceOf(Date);
    await svc.openForTribe(String(tribe), String(inv._id));
    expect((await invoices.findById(inv._id).lean())!.viewedAt).toEqual(first);
    await expect(
      svc.openForTribe(String(other), String(inv._id)),
    ).rejects.toThrow('Invoice not found');

    const replaced = await svc.replaceFile(String(inv._id), file());
    expect(replaced.viewedAt).toBeUndefined();
    expect((await svc.listForTribe(String(tribe))).unviewed).toBe(1);
  });
});
