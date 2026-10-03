import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BarcodesService } from './barcodes.service';
import { Barcode, BarcodeType } from '../../schemas/barcode.schema';
import { BulkCreateBarcodesDto } from './dto/bulk-create-barcodes.dto';

const exec = (result: unknown) => ({
  exec: jest.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  ),
});
const duplicateKey = () =>
  Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

describe('BarcodesService', () => {
  let service: BarcodesService;
  let model: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
    insertMany: jest.Mock;
  };

  beforeEach(async () => {
    model = {
      findOne: jest.fn(() => exec(null)),
      findOneAndUpdate: jest.fn(() => exec(null)),
      updateOne: jest.fn(() => exec({})),
      insertMany: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BarcodesService,
        { provide: getModelToken(Barcode.name), useValue: model },
      ],
    }).compile();
    service = module.get(BarcodesService);
  });

  describe('assignToOrder', () => {
    it('returns the barcode the order already holds when the type matches', async () => {
      const held = { _id: 'b1', code: 'EN1', type: BarcodeType.SPEED_POST };
      model.findOne.mockReturnValueOnce(exec(held));

      await expect(
        service.assignToOrder('o1', BarcodeType.SPEED_POST),
      ).resolves.toBe(held);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('claims the oldest available barcode of the type', async () => {
      const claimed = { _id: 'b2', code: 'EN2' };
      model.findOneAndUpdate.mockReturnValueOnce(exec(claimed));

      await expect(
        service.assignToOrder('o1', BarcodeType.SPEED_POST),
      ).resolves.toBe(claimed);
      const [filter, , options] = model.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({
        type: BarcodeType.SPEED_POST,
        assignedOrderId: null,
        manuallyUsedAt: null,
      });
      expect(options).toMatchObject({ sort: { createdAt: 1 } });
    });

    it('settles a concurrent claim for the same order on the winner', async () => {
      const winner = { _id: 'b3', code: 'EN3', type: BarcodeType.SPEED_POST };
      model.findOne
        .mockReturnValueOnce(exec(null)) // nothing held yet…
        .mockReturnValueOnce(exec(winner)); // …until the other pack won.
      model.findOneAndUpdate.mockReturnValueOnce(exec(duplicateKey()));

      await expect(
        service.assignToOrder('o1', BarcodeType.SPEED_POST),
      ).resolves.toBe(winner);
    });

    it('swaps a barcode of the wrong type for one of the requested type', async () => {
      const held = { _id: 'old', code: 'SP1', type: BarcodeType.SPEED_POST };
      const reserved = { _id: 'new', code: 'BP1' };
      const assigned = { ...reserved, type: BarcodeType.BUSINESS_PARCEL };
      model.findOne.mockReturnValueOnce(exec(held));
      model.findOneAndUpdate
        .mockReturnValueOnce(exec(reserved))
        .mockReturnValueOnce(exec(assigned));

      await expect(
        service.assignToOrder('o1', BarcodeType.BUSINESS_PARCEL),
      ).resolves.toBe(assigned);

      // Reserved first, so the order is never left without a barcode…
      const [reserveFilter, reserveUpdate] =
        model.findOneAndUpdate.mock.calls[0];
      expect(reserveFilter).toMatchObject({
        type: BarcodeType.BUSINESS_PARCEL,
      });
      expect(reserveUpdate.$set.manuallyUsedAt).toBeInstanceOf(Date);
      // …then the old one goes back to the pool…
      expect(model.updateOne.mock.calls[0][0]).toEqual({
        _id: 'old',
        assignedOrderId: 'o1',
      });
      // …and the reservation becomes the assignment.
      const [, assignUpdate] = model.findOneAndUpdate.mock.calls[1];
      expect(assignUpdate.$set).toMatchObject({
        assignedOrderId: 'o1',
        manuallyUsedAt: null,
      });
    });

    it('keeps the old barcode and reports pending when none of the new type are left', async () => {
      const held = { _id: 'old', code: 'SP1', type: BarcodeType.SPEED_POST };
      model.findOne.mockReturnValueOnce(exec(held));

      await expect(
        service.assignToOrder('o1', BarcodeType.BUSINESS_PARCEL),
      ).resolves.toBeNull();
      // Nothing released: the order still shows that code.
      expect(model.updateOne).not.toHaveBeenCalled();
    });

    it('no longer exposes the unchecked claim()', () => {
      expect(
        (service as unknown as Record<string, unknown>).claim,
      ).toBeUndefined();
    });
  });

  describe('bulkCreate', () => {
    it('counts duplicates as skipped', async () => {
      model.insertMany.mockRejectedValueOnce(
        Object.assign(new Error('bulk write'), {
          writeErrors: [{ code: 11000 }, { err: { code: 11000 } }],
          insertedDocs: [{}],
        }),
      );
      await expect(
        service.bulkCreate(BarcodeType.SPEED_POST, ['A1', 'A2', 'A3']),
      ).resolves.toEqual({ inserted: 1, skipped: 2, total: 3 });
    });

    it('surfaces any other failure instead of calling it "skipped"', async () => {
      model.insertMany.mockRejectedValueOnce(new Error('connection reset'));
      await expect(
        service.bulkCreate(BarcodeType.SPEED_POST, ['A1']),
      ).rejects.toThrow('connection reset');
    });

    it('surfaces a mix of duplicates and real errors', async () => {
      model.insertMany.mockRejectedValueOnce(
        Object.assign(new Error('bulk write'), {
          writeErrors: [{ code: 11000 }, { code: 121 }],
          insertedDocs: [],
        }),
      );
      await expect(
        service.bulkCreate(BarcodeType.SPEED_POST, ['A1', 'A2']),
      ).rejects.toThrow('bulk write');
    });
  });
});

describe('BulkCreateBarcodesDto', () => {
  const check = async (codes: unknown) => {
    const dto = plainToInstance(BulkCreateBarcodesDto, {
      type: BarcodeType.SPEED_POST,
      codes,
    });
    return { dto, errors: await validate(dto) };
  };

  it('accepts article numbers, trimming spreadsheet quoting', async () => {
    const { dto, errors } = await check([' EN409716859IN ', '"RK775227016IN"']);
    expect(errors).toHaveLength(0);
    expect(dto.codes).toEqual(['EN409716859IN', 'RK775227016IN']);
  });

  it('rejects codes with anything but letters, digits and dashes', async () => {
    expect((await check(['EN 4097'])).errors).not.toHaveLength(0);
    expect((await check(['{"$gt":""}'])).errors).not.toHaveLength(0);
  });

  it('rejects over-long codes and oversized batches', async () => {
    expect((await check(['A'.repeat(33)])).errors).not.toHaveLength(0);
    expect(
      (await check(Array.from({ length: 5001 }, (_, i) => `A${i}`))).errors,
    ).not.toHaveLength(0);
  });
});
