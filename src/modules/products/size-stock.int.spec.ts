// Per-size stock against a real MongoDB — the logic is in the atomic updates,
// so a mocked model would prove nothing. Runs only when MONGO_TEST_URI points
// at a throwaway database (it is dropped), e.g.:
//   MONGO_TEST_URI=mongodb://localhost:27017/shipkit_sizetest npx jest size-stock
import { ConflictException, BadRequestException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { Product, ProductSchema } from '../../schemas/product.schema';
import {
  InventoryLog,
  InventoryLogSchema,
} from '../../schemas/inventory-log.schema';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { ProductsService, unassignedOf } from './products.service';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('per-size stock', () => {
  let conn: mongoose.Connection;
  let products: Model<Product>;
  let logs: Model<InventoryLog>;
  let orders: Model<Order>;
  let svc: ProductsService;
  const coachId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
    products = conn.model<Product>('Product', ProductSchema);
    logs = conn.model<InventoryLog>('InventoryLog', InventoryLogSchema);
    orders = conn.model<Order>('Order', OrderSchema);
    conn.model(Tribe.name, TribeSchema); // findSized populates the tribe
    svc = new ProductsService(products, logs, orders);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  beforeEach(async () => {
    await products.deleteMany({});
    await logs.deleteMany({});
    await orders.deleteMany({});
  });

  let n = 0;
  const make = (extra: any = {}) =>
    products.create({
      coachId,
      name: 'Tee',
      baseProductionCost: 100,
      sku: `T-${++n}`,
      stockLevel: 40,
      customizationType: 'SIZE',
      ...extra,
    });
  const get = async (id: any) => (await products.findById(id).lean())!;
  const qty = (p: any, size: string) =>
    p.sizeStock?.find((s: any) => s.size === size)?.qty;

  it('a sized order before any split creates the size bucket and leaves Unassigned intact', async () => {
    const p = await make();
    await svc.decrementStock(String(p._id), 1, 'm'); // case-insensitive
    const after = await get(p._id);
    expect(after.stockLevel).toBe(39);
    expect(qty(after, 'M')).toBe(-1);
    expect(unassignedOf(after)).toBe(40); // the 40 physical units are still uncounted
  });

  it('never blocks: stock goes below zero, total and size together', async () => {
    const p = await make({ stockLevel: 2, sizeStock: [{ size: 'L', qty: 2 }] });
    for (let i = 0; i < 5; i++) await svc.decrementStock(String(p._id), 1, 'L');
    const after = await get(p._id);
    expect(qty(after, 'L')).toBe(-3);
    expect(after.stockLevel).toBe(-3);
  });

  it('an unknown size or no size moves only Unassigned', async () => {
    const p = await make({
      stockLevel: 10,
      sizeStock: [{ size: 'S', qty: 4 }],
    });
    await svc.decrementStock(String(p._id), 2, 'XXXL');
    await svc.decrementStock(String(p._id), 1);
    const after = await get(p._id);
    expect(after.stockLevel).toBe(7);
    expect(qty(after, 'S')).toBe(4);
    expect(unassignedOf(after)).toBe(3);
  });

  it('a non-sized product ignores the size entirely', async () => {
    const p = await make({ customizationType: undefined });
    await svc.decrementStock(String(p._id), 3, 'M');
    const after = await get(p._id);
    expect(after.stockLevel).toBe(37);
    expect(after.sizeStock).toBeUndefined();
  });

  it('a returned/rejected order puts stock back into its size', async () => {
    const p = await make({ stockLevel: 5, sizeStock: [{ size: 'M', qty: 5 }] });
    await svc.decrementStock(String(p._id), 2, 'M');
    await svc.incrementStock(String(p._id), 2, 'M');
    const after = await get(p._id);
    expect(qty(after, 'M')).toBe(5);
    expect(after.stockLevel).toBe(5);
  });

  it('concurrent first orders for a new size make one bucket, not two', async () => {
    const p = await make();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.decrementStock(String(p._id), 1, 'XL'),
      ),
    );
    const after = await get(p._id);
    expect(after.sizeStock!.filter((s) => s.size === 'XL')).toHaveLength(1);
    expect(qty(after, 'XL')).toBe(-10);
    expect(after.stockLevel).toBe(30);
  });

  it('split: sets sizes + Unassigned, total becomes their sum, each change logged', async () => {
    const p = await make();
    const fresh = await get(p._id);
    await svc.setSizeStock(String(p._id), {
      sizes: [
        { size: 's', qty: 10 },
        { size: 'M', qty: 20 },
      ],
      unassigned: 12, // physical count: 42, two more than the system thought
      reason: 'Launch count',
      expectedUpdatedAt: (fresh as any).updatedAt.toISOString(),
    });
    const after = await get(p._id);
    expect(qty(after, 'S')).toBe(10);
    expect(qty(after, 'M')).toBe(20);
    expect(after.stockLevel).toBe(42);
    expect(unassignedOf(after)).toBe(12);
    const l = await logs.find({ productId: p._id } as any).lean();
    expect(
      l.map((x: any) => `${x.size}:${x.type}:${x.quantity}`).sort(),
    ).toEqual(['M:ADD:20', 'S:ADD:10', 'Unassigned:REMOVE:28']);
  });

  it('split: rejects a stale save when an order moved stock meanwhile', async () => {
    const p = await make();
    const seen = await get(p._id);
    await new Promise((r) => setTimeout(r, 5));
    await svc.decrementStock(String(p._id), 1, 'M'); // a claim lands while the page is open
    await expect(
      svc.setSizeStock(String(p._id), {
        sizes: [{ size: 'M', qty: 40 }],
        unassigned: 0,
        expectedUpdatedAt: (seen as any).updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('split: refuses a size the product does not offer', async () => {
    const p = await make({ sizeOptions: ['30', '32'] });
    const seen = await get(p._id);
    await expect(
      svc.setSizeStock(String(p._id), {
        sizes: [{ size: 'M', qty: 1 }],
        unassigned: 0,
        expectedUpdatedAt: (seen as any).updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('manual add/remove by size; removal cannot take a bucket below zero', async () => {
    const p = await make({ stockLevel: 6, sizeStock: [{ size: 'M', qty: 2 }] });
    await svc.addInventory(String(p._id), 5, 'New batch', undefined, 'M');
    expect(qty(await get(p._id), 'M')).toBe(7);
    await expect(
      svc.removeInventory(String(p._id), 8, 'Damaged', undefined, 'M'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.removeInventory(String(p._id), 5, 'Damaged'),
    ).rejects.toBeInstanceOf(BadRequestException); // Unassigned has 4
    await svc.removeInventory(String(p._id), 4, 'Damaged');
    const after = await get(p._id);
    expect(after.stockLevel).toBe(7);
    expect(unassignedOf(after)).toBe(0);
    const sizes = (await logs.find({ productId: p._id } as any).lean())
      .map((x: any) => x.size)
      .sort();
    expect(sizes).toEqual(['M', 'Unassigned']);
  });

  it('findSized: counts units on open orders per size, ignoring shipped/rejected/dropped', async () => {
    const p = await make({ sizeOptions: ['S', 'M'] });
    const line = (size: string, quantity = 1, extra: any = {}) => ({
      productId: p._id,
      quantity,
      baseCost: 0,
      retailPrice: 0,
      commission: 0,
      customizationType: 'SIZE',
      customizationValue: size,
      ...extra,
    });
    const order = (status: string, items: any[], extra: any = {}) =>
      orders.collection.insertOne({
        coachId,
        type: 'WELCOME_KIT',
        status,
        items,
        isDeleted: false,
        ...extra,
      });
    await order('NEW', [line('m', 2)]);
    await order('PACKED', [line('M')]);
    await order('NEW', [line('Huge')]); // unknown size → Unassigned
    await order('DISPATCHED', [line('M', 5)]); // left the shelf
    await order('NEW', [line('S', 3)], { approvalStatus: 'REJECTED' });
    await order('NEW', [line('S', 4, { selected: false })]); // dropped at approval
    await order('NEW', [line('S', 1)], { isDeleted: true });
    const [row] = await svc.findSized();
    expect(row.promised).toEqual({ M: 3, Unassigned: 1 });
  });
});
