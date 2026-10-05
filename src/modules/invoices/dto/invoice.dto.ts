import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const MAX_INVOICE_NUMBER = 64;
export const MAX_INVOICE_REFERENCE = 120;
export const MAX_INVOICE_NOTE = 500;

// Multipart fields arrive as strings; JSON (PATCH) as their own types.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// '' → undefined, numeric strings → numbers. Not `@Type(() => Number)`, which
// would turn an empty field into 0.
const toNumber = ({ value }: { value: unknown }) => {
  if (typeof value === 'string') {
    const v = value.trim();
    return v === '' ? undefined : Number(v);
  }
  return value;
};
// Optional text on create: an empty form field means "not given".
const optionalText = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? undefined : v;
};
// Optional text on update: '' or null clears it.
const clearableText = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? null : v;
};

/** Multipart fields of `POST /admin/invoices` (the PDF is the `file` part). */
export class CreateInvoiceDto {
  @IsMongoId()
  coachId: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_INVOICE_NUMBER)
  invoiceNumber: string;

  @Transform(trim)
  @IsISO8601({ strict: true })
  invoiceDate: string;

  @Transform(toNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;

  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INVOICE_REFERENCE)
  reference?: string;

  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INVOICE_NOTE)
  note?: string;
}

/** JSON body of `PATCH /admin/invoices/:id` — any subset of the metadata. */
export class UpdateInvoiceDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_INVOICE_NUMBER)
  invoiceNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsISO8601({ strict: true })
  invoiceDate?: string;

  @IsOptional()
  @Transform(toNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  // null or '' clears it.
  @Transform(clearableText)
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(MAX_INVOICE_REFERENCE)
  reference?: string | null;

  @Transform(clearableText)
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(MAX_INVOICE_NOTE)
  note?: string | null;
}
