import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

// Catch-all filter: log server errors (with context) and return a clean JSON
// body. Prevents raw 500s / stack traces from leaking to clients.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    const { status, detail } = this.resolve(exception);

    // Query strings carry phone numbers, emails and search terms — keep them
    // out of the logs; the path is enough to find the handler.
    const url = String(req?.originalUrl || req?.url || '').split('?')[0];
    const where = `${req?.method} ${url}`;
    if (status >= 500) {
      this.logger.error(
        `${where} -> ${status}`,
        (exception as any)?.stack || String(exception),
      );
    } else {
      this.logger.warn(`${where} -> ${status}`);
    }

    // A streamed response (media proxy) can fail after the headers went out;
    // writing a second response would throw inside the filter.
    if (res.headersSent) {
      res.end?.();
      return;
    }

    const body =
      typeof detail === 'string'
        ? { statusCode: status, message: detail }
        : detail;
    res.status(status).json(body);
  }

  /**
   * Status + client-safe body. Database errors that reach here are almost
   * always bad input (a malformed id, a duplicate unique value), so they map to
   * 4xx rather than surfacing as a 500.
   */
  private resolve(exception: unknown): { status: number; detail: unknown } {
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), detail: exception.getResponse() };
    }

    const err = exception as {
      name?: string;
      code?: number;
      path?: string;
      errors?: Record<string, unknown>;
    } | null;

    // Mongoose CastError — e.g. "abc" where an ObjectId was expected.
    if (err?.name === 'CastError') {
      return {
        status: HttpStatus.BAD_REQUEST,
        detail: err.path ? `Invalid value for ${err.path}` : 'Invalid id',
      };
    }
    // Mongoose schema validation; field names are ours, not user data.
    if (err?.name === 'ValidationError') {
      const fields = Object.keys(err.errors ?? {});
      return {
        status: HttpStatus.BAD_REQUEST,
        detail: fields.length
          ? `Validation failed: ${fields.join(', ')}`
          : 'Validation failed',
      };
    }
    // Mongo duplicate key on a unique index.
    if (err?.code === 11000) {
      return {
        status: HttpStatus.CONFLICT,
        detail: 'A record with this value already exists',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Internal server error',
    };
  }
}
