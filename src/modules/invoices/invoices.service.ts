import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Readable } from 'stream';
import { TribeInvoice } from '../../schemas/tribe-invoice.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { UploadsService } from '../uploads/uploads.service';
import { refIdOf } from '../../common/utils/ownership';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import { UploadedPdf, assertPdf, cleanOriginalName } from './invoice-file';

export const DUPLICATE_INVOICE = 'Invoice number already exists for this tribe';
export const NOT_CONFIGURED = 'File uploads are not configured.';
const NOT_FOUND = 'Invoice not found';
const DAY_MS = 24 * 60 * 60 * 1000;
/** An invoice date may be at most this far in the future. */
export const MAX_FUTURE_DAYS = 31;

// Populated tribe on the all-tribes admin list.
const TRIBE_POPULATE = { path: 'coachId', select: 'username brand name' };
const NEWEST_FIRST = { invoiceDate: -1, createdAt: -1 } as const;
const LIVE = { isDeleted: false } as const;

/** The invoice as every response carries it — never `fileKey`. */
export interface InvoiceResponse {
  _id: unknown;
  coachId: unknown;
  invoiceNumber: string;
  invoiceDate: Date;
  reference?: string;
  amount: number;
  note?: string;
  fileName: string;
  fileSize: number;
  viewedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Whitelists the contract's fields, so internal ones can never leak. */
export function toInvoiceResponse(doc: any): InvoiceResponse {
  const d = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  const out: InvoiceResponse = {
    _id: d._id,
    coachId: d.coachId,
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    amount: d.amount,
    fileName: d.fileName,
    fileSize: d.fileSize,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
  if (d.reference != null) out.reference = d.reference;
  if (d.note != null) out.note = d.note;
  if (d.viewedAt != null) out.viewedAt = d.viewedAt;
  return out;
}

/** An opened invoice PDF, ready for the controller to stream. */
export interface InvoiceFile {
  invoiceNumber: string;
  stream: Readable;
  contentLength?: number;
}

const isDuplicateKey = (err: unknown) =>
  (err as { code?: number })?.code === 11000;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @InjectModel(TribeInvoice.name) private invoiceModel: Model<TribeInvoice>,
    // Read-only: ownership and the tribe the admin uploads to.
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
    private readonly uploads: UploadsService,
  ) {}

  /** The signed-in TRIBE user's own tribe id — never taken from the request. */
  async tribeIdForUser(userId: string): Promise<string> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id')
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');
    return String((tribe as any)._id);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  async create(
    dto: CreateInvoiceDto,
    file: UploadedPdf | undefined,
    uploadedBy: string,
  ): Promise<InvoiceResponse> {
    const pdf = assertPdf(file);
    const invoiceDate = this.parseInvoiceDate(dto.invoiceDate);
    if (!this.uploads.isConfigured()) {
      throw new ServiceUnavailableException(NOT_CONFIGURED);
    }
    const tribe = await this.tribeModel
      .findById(dto.coachId)
      .select('_id')
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');
    const coachId = String((tribe as any)._id);
    const invoiceNumber = dto.invoiceNumber.trim();
    // Checked before uploading so a duplicate doesn't leave an orphan object;
    // the unique index still decides a race (handled below).
    await this.assertNumberFree(coachId, invoiceNumber);

    const fileKey = await this.uploads.putPrivatePdf(coachId, pdf.buffer);
    try {
      const doc = await this.invoiceModel.create({
        coachId,
        invoiceNumber,
        invoiceDate,
        amount: dto.amount,
        ...(dto.reference ? { reference: dto.reference } : {}),
        ...(dto.note ? { note: dto.note } : {}),
        fileKey,
        fileName: cleanOriginalName(pdf.originalname),
        fileSize: pdf.buffer.length,
        uploadedBy: isValidObjectId(uploadedBy) ? uploadedBy : undefined,
        isDeleted: false,
      } as any);
      return toInvoiceResponse(doc);
    } catch (err) {
      await this.uploads.deletePrivateObject(fileKey);
      if (isDuplicateKey(err)) throw new ConflictException(DUPLICATE_INVOICE);
      throw err;
    }
  }

  /** Live invoices, newest invoice date first; all tribes unless `coachId`. */
  async list(coachId?: string): Promise<InvoiceResponse[]> {
    const filter: Record<string, unknown> = { ...LIVE };
    if (coachId) {
      if (!isValidObjectId(coachId)) {
        throw new BadRequestException('Invalid coachId');
      }
      filter.coachId = coachId;
    }
    let q = this.invoiceModel.find(filter as any).sort(NEWEST_FIRST);
    if (!coachId) q = q.populate(TRIBE_POPULATE);
    const docs = await q.lean().exec();
    return docs.map(toInvoiceResponse);
  }

  async update(id: string, dto: UpdateInvoiceDto): Promise<InvoiceResponse> {
    const current = await this.findLive(id);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    if (dto.invoiceNumber !== undefined) {
      const invoiceNumber = dto.invoiceNumber.trim();
      if (invoiceNumber !== current.invoiceNumber) {
        await this.assertNumberFree(refIdOf(current.coachId), invoiceNumber);
        $set.invoiceNumber = invoiceNumber;
      }
    }
    if (dto.invoiceDate !== undefined) {
      $set.invoiceDate = this.parseInvoiceDate(dto.invoiceDate);
    }
    if (dto.amount !== undefined) $set.amount = dto.amount;
    for (const key of ['reference', 'note'] as const) {
      const v = dto[key];
      if (v === undefined) continue;
      if (v === null) $unset[key] = '';
      else $set[key] = v;
    }

    const change: Record<string, unknown> = {};
    if (Object.keys($set).length) change.$set = $set;
    if (Object.keys($unset).length) change.$unset = $unset;
    if (!Object.keys(change).length) return toInvoiceResponse(current);

    try {
      const doc = await this.invoiceModel
        .findOneAndUpdate({ _id: id, ...LIVE } as any, change, {
          returnDocument: 'after',
        })
        .lean()
        .exec();
      if (!doc) throw new NotFoundException(NOT_FOUND);
      return toInvoiceResponse(doc);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictException(DUPLICATE_INVOICE);
      throw err;
    }
  }

  /**
   * Swaps the PDF. The tribe hasn't seen the new one, so `viewedAt` is reset;
   * the old object is deleted best-effort once the record points at the new.
   */
  async replaceFile(
    id: string,
    file: UploadedPdf | undefined,
  ): Promise<InvoiceResponse> {
    const pdf = assertPdf(file);
    if (!this.uploads.isConfigured()) {
      throw new ServiceUnavailableException(NOT_CONFIGURED);
    }
    const current = await this.findLive(id, true);
    const fileKey = await this.uploads.putPrivatePdf(
      refIdOf(current.coachId),
      pdf.buffer,
    );
    const doc = await this.invoiceModel
      .findOneAndUpdate(
        { _id: id, ...LIVE } as any,
        {
          $set: {
            fileKey,
            fileName: cleanOriginalName(pdf.originalname),
            fileSize: pdf.buffer.length,
          },
          $unset: { viewedAt: '' },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!doc) {
      // Deleted while we uploaded: don't keep the new object either.
      await this.uploads.deletePrivateObject(fileKey);
      throw new NotFoundException(NOT_FOUND);
    }
    if (current.fileKey !== fileKey) {
      await this.uploads.deletePrivateObject(current.fileKey);
    }
    return toInvoiceResponse(doc);
  }

  /** Soft delete: hidden from the tribe, number freed, object removed. */
  async remove(id: string): Promise<{ success: true }> {
    if (!isValidObjectId(id)) throw new NotFoundException(NOT_FOUND);
    const doc = await this.invoiceModel
      .findOneAndUpdate(
        { _id: id, ...LIVE } as any,
        { $set: { isDeleted: true, deletedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .select('+fileKey')
      .lean()
      .exec();
    if (!doc) throw new NotFoundException(NOT_FOUND);
    await this.uploads.deletePrivateObject((doc as any).fileKey);
    return { success: true };
  }

  /** The admin's view of any live invoice's PDF (doesn't touch `viewedAt`). */
  async openForAdmin(id: string): Promise<InvoiceFile> {
    const invoice = await this.findLive(id, true);
    return this.open(invoice);
  }

  // ── Tribe ─────────────────────────────────────────────────────────────────

  async listForTribe(
    tribeId: string,
  ): Promise<{ invoices: InvoiceResponse[]; unviewed: number }> {
    const docs = await this.invoiceModel
      .find({ coachId: tribeId, ...LIVE } as any)
      .sort(NEWEST_FIRST)
      .lean()
      .exec();
    const invoices = docs.map(toInvoiceResponse);
    return {
      invoices,
      unviewed: invoices.filter((i) => !i.viewedAt).length,
    };
  }

  /**
   * The tribe's own live invoice only — another tribe's, a deleted one or a
   * malformed id are all the same 404. Marks it viewed the first time.
   */
  async openForTribe(tribeId: string, id: string): Promise<InvoiceFile> {
    if (!isValidObjectId(id)) throw new NotFoundException(NOT_FOUND);
    const invoice = await this.invoiceModel
      .findOne({ _id: id, coachId: tribeId, ...LIVE } as any)
      .select('+fileKey')
      .lean()
      .exec();
    if (!invoice) throw new NotFoundException(NOT_FOUND);
    const file = await this.open(invoice as any);
    // Conditional, so the first view is the one kept.
    await this.invoiceModel
      .updateOne(
        { _id: id, viewedAt: { $exists: false } } as any,
        { $set: { viewedAt: new Date() } },
        { timestamps: false },
      )
      .exec();
    return file;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async open(invoice: {
    invoiceNumber: string;
    fileKey: string;
  }): Promise<InvoiceFile> {
    if (!this.uploads.isConfigured()) {
      throw new ServiceUnavailableException(NOT_CONFIGURED);
    }
    const obj = await this.uploads.getPrivateObject(invoice.fileKey);
    return {
      invoiceNumber: invoice.invoiceNumber,
      stream: obj.stream,
      contentLength: obj.contentLength,
    };
  }

  private async findLive(id: string, withKey = false): Promise<TribeInvoice> {
    if (!isValidObjectId(id)) throw new NotFoundException(NOT_FOUND);
    let q = this.invoiceModel.findOne({ _id: id, ...LIVE } as any);
    if (withKey) q = q.select('+fileKey');
    const doc = await q.lean().exec();
    if (!doc) throw new NotFoundException(NOT_FOUND);
    return doc as unknown as TribeInvoice;
  }

  private async assertNumberFree(coachId: string, invoiceNumber: string) {
    const taken = await this.invoiceModel
      .findOne({ coachId, invoiceNumber, ...LIVE } as any)
      .select('_id')
      .lean()
      .exec();
    if (taken) throw new ConflictException(DUPLICATE_INVOICE);
  }

  /** ISO date, not more than 31 days ahead. */
  private parseInvoiceDate(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        'invoiceDate must be a valid ISO 8601 date',
      );
    }
    if (date.getTime() > Date.now() + MAX_FUTURE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `Invoice date can't be more than ${MAX_FUTURE_DAYS} days in the future`,
      );
    }
    return date;
  }
}
