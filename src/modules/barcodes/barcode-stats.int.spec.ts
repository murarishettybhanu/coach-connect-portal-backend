import mongoose, { Connection, Model, Types } from 'mongoose';
import { BarcodesService } from './barcodes.service';
import {
  Barcode,
  BarcodeSchema,
  BarcodeType,
} from '../../schemas/barcode.schema';

// Real MongoDB: the bug was in aggregation semantics (a missing field is not
// null there), which a mocked model can't reproduce. Skipped without
// MONGO_TEST_URI; uses its own throwaway database.
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('BarcodesService.stats (real Mongo)', () => {
  let conn: Connection;
  let model: Model<Barcode>;
  let svc: BarcodesService;

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(URI!, { dbName: 'shipkit_barcodetest' })
      .asPromise();
    model = conn.model<Barcode>('Barcode', BarcodeSchema);
    svc = new BarcodesService(model as any);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  beforeEach(() => model.deleteMany({}));

  it('counts barcodes stored before manuallyUsedAt existed as available', async () => {
    // Raw inserts, like the documents uploaded before the field was added:
    // no manuallyUsedAt key at all, assignedOrderId null.
    await model.collection.insertMany([
      { code: 'SP1', type: BarcodeType.SPEED_POST, assignedOrderId: null },
      { code: 'SP2', type: BarcodeType.SPEED_POST, assignedOrderId: null },
      {
        code: 'BP1',
        type: BarcodeType.BUSINESS_PARCEL,
        assignedOrderId: new Types.ObjectId(),
      },
      { code: 'BP2', type: BarcodeType.BUSINESS_PARCEL, assignedOrderId: null },
      {
        code: 'BP3',
        type: BarcodeType.BUSINESS_PARCEL,
        assignedOrderId: null,
        manuallyUsedAt: new Date(),
      },
      // No assignedOrderId key either.
      { code: 'BP4', type: BarcodeType.BUSINESS_PARCEL },
    ]);

    const stats = await svc.stats();
    expect(stats[BarcodeType.SPEED_POST]).toEqual({
      total: 2,
      used: 0,
      available: 2,
    });
    expect(stats[BarcodeType.BUSINESS_PARCEL]).toEqual({
      total: 4,
      used: 2, // assigned to an order + written off by hand
      available: 2,
    });
  });
});
