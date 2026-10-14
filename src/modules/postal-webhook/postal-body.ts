import { text, type NextFunction, type Request, type Response } from 'express';

/** India Post webhook bodies: up to this size, whatever their Content-Type. */
export const POSTAL_BODY_LIMIT = '5mb';

/**
 * Reads a webhook body that should be JSON however it is labelled
 * (application/json, text/plain, a form field holding JSON …). Returns the
 * parsed value, or undefined when nothing in it is JSON.
 */
export function parseLooseJson(raw: string): unknown {
  const body = raw.trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    // Not plain JSON — maybe form-encoded with the JSON in one of the fields.
  }
  if (/^[\w.%-]+=/.test(body)) {
    for (const value of new URLSearchParams(body).values()) {
      try {
        return JSON.parse(value);
      } catch {
        // try the next field
      }
    }
  }
  return undefined;
}

/**
 * Express middleware for the India Post webhook routes, mounted before Nest's
 * own JSON parser (which only reads application/json, up to 100 kb). Keeps the
 * raw text on `req.postalRaw` for the delivery log.
 */
export const postalBodyParser = [
  text({ type: () => true, limit: POSTAL_BODY_LIMIT }),
  (req: Request, _res: Response, next: NextFunction) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    (req as any).postalRaw = raw;
    req.body = parseLooseJson(raw) ?? {};
    next();
  },
];
