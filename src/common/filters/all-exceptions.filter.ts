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

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const detail =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const where = `${req?.method} ${req?.originalUrl || req?.url}`;
    if (status >= 500) {
      this.logger.error(
        `${where} -> ${status}`,
        (exception as any)?.stack || String(exception),
      );
    } else {
      this.logger.warn(`${where} -> ${status}`);
    }

    const body =
      typeof detail === 'string' ? { statusCode: status, message: detail } : detail;
    res.status(status).json(body);
  }
}
