import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

// Deep enough for any real form or CSV payload; anything nested further is
// refused rather than walked, so a hostile body can't blow the stack.
const MAX_DEPTH = 32;

/**
 * Rejects request bodies carrying MongoDB operator keys anywhere inside them.
 *
 * Many handlers take `@Body() x: any` and hand it to `findByIdAndUpdate` or a
 * query filter. ValidationPipe only sanitises DTO-typed bodies, so without this
 * a body like `{"$set": {"role": "ADMIN"}}` or `{"price": {"$gt": 0}}` would
 * reach Mongo as an operator. This is the global backstop: a key that starts
 * with `$`, or a dotted path with a `$` segment (`"items.$.price"`,
 * `"a.$where"`), is a 400 before any handler runs.
 *
 * Plain dotted keys are left alone — they are not operators — and so are the
 * WhatsApp webhook's Meta payloads, which never use either form. The pipe only
 * reads the parsed body, so `req.rawBody` (used for the webhook signature) is
 * untouched.
 */
@Injectable()
export class RejectOperatorKeysPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body') return value;
    const offending = findOperatorKey(value);
    if (offending !== null) {
      throw new BadRequestException(
        `Invalid field name "${offending.slice(0, 64)}" in request body`,
      );
    }
    return value;
  }
}

/** The first operator-looking key in `value`, or null when there is none. */
export function findOperatorKey(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return '(nested too deeply)';
  // Buffers and dates are leaf values, not documents.
  if (Buffer.isBuffer(value) || value instanceof Date) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOperatorKey(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (isOperatorKey(key)) return key;
    const found = findOperatorKey(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    if (found !== null) return found;
  }
  return null;
}

function isOperatorKey(key: string): boolean {
  return key.split('.').some((segment) => segment.startsWith('$'));
}
