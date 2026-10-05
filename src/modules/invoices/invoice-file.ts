import { BadRequestException } from '@nestjs/common';

export const MAX_INVOICE_PDF_BYTES = 10 * 1024 * 1024;
export const PDF_TOO_LARGE = 'PDF must be 10 MB or smaller';
export const ONLY_PDF = 'Only PDF files are allowed';

/** An uploaded file as multer (memory storage) hands it over. */
export interface UploadedPdf {
  originalname?: string;
  buffer: Buffer;
  size?: number;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** True when the bytes start with the PDF signature `%PDF-`. */
export function isPdf(buf: Buffer | null | undefined): boolean {
  return (
    !!buf &&
    buf.length >= PDF_MAGIC.length &&
    buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
  );
}

/**
 * Validates an uploaded invoice PDF by its bytes — the client's mimetype and
 * file name are ignored. Throws the contract's 400 messages.
 */
export function assertPdf(file: UploadedPdf | null | undefined): UploadedPdf {
  if (!file || !file.buffer) throw new BadRequestException('No file provided');
  const size = file.buffer.length;
  if (size > MAX_INVOICE_PDF_BYTES)
    throw new BadRequestException(PDF_TOO_LARGE);
  if (!isPdf(file.buffer)) throw new BadRequestException(ONLY_PDF);
  return file;
}

/**
 * The download name, `<invoiceNumber>.pdf`, reduced to characters that are
 * safe in a Content-Disposition header and on every filesystem: anything other
 * than letters, digits, `.`, `-` and `_` becomes `_` (runs collapsed), leading
 * dots/underscores/dashes and trailing dots/underscores are dropped, and it's
 * capped at 100 characters (falls back to `invoice`).
 */
export function invoiceDownloadName(invoiceNumber: string | null | undefined) {
  const base = String(invoiceNumber ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._]+$/, '')
    .slice(0, 100);
  return `${base || 'invoice'}.pdf`;
}

/** `inline` (view) or `attachment` (download) with the sanitised name. */
export function contentDisposition(invoiceNumber: string, download: boolean) {
  return `${download ? 'attachment' : 'inline'}; filename="${invoiceDownloadName(invoiceNumber)}"`;
}

/**
 * The original name as uploaded, kept for the admin's display: path parts and
 * control characters removed, capped at 255. Never used in a header.
 */
export function cleanOriginalName(name: string | null | undefined): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  return base || 'invoice.pdf';
}

/** `?download=1` (or `true`) asks for an attachment. */
export function wantsDownload(value: unknown): boolean {
  return value === '1' || value === 'true';
}
