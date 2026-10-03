import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  let res: {
    headersSent: boolean;
    status: jest.Mock;
    json: jest.Mock;
    end: jest.Mock;
  };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  const hostFor = (url = '/api/orders/abc') =>
    ({
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'GET', originalUrl: url }),
      }),
    }) as unknown as ArgumentsHost;

  beforeEach(() => {
    res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes HttpExceptions through as they are', () => {
    filter.catch(new BadRequestException('Bad pincode'), hostFor());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Bad pincode' }),
    );
  });

  it('maps a Mongoose CastError (malformed id) to 400', () => {
    const cast = new MongooseError.CastError('ObjectId', 'abc', '_id');
    filter.catch(cast, hostFor());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'Invalid value for _id',
    });
  });

  it('maps a Mongoose ValidationError to 400, naming only the fields', () => {
    const validation = new MongooseError.ValidationError();
    validation.addError(
      'email',
      new MongooseError.ValidatorError({
        path: 'email',
        message: 'secret detail',
      }),
    );
    filter.catch(validation, hostFor());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'Validation failed: email',
    });
  });

  it('maps a duplicate key to 409 without echoing the key value', () => {
    const dup = Object.assign(
      new Error('E11000 duplicate key error dup key: { email: "asha@x.com" }'),
      { name: 'MongoServerError', code: 11000 },
    );
    filter.catch(dup, hostFor());
    expect(res.status).toHaveBeenCalledWith(409);
    const [body] = res.json.mock.calls[0] as [{ message: string }];
    expect(body.message).not.toContain('asha');
  });

  it('hides anything else behind a generic 500', () => {
    filter.catch(new Error('connection string mongodb://user:pw@h'), hostFor());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(error).toHaveBeenCalled();
  });

  it('keeps query strings (phone numbers, emails) out of the log', () => {
    filter.catch(
      new BadRequestException('x'),
      hostFor('/api/whatsapp/messages?from=919876543210'),
    );
    const [line] = warn.mock.calls[0] as [string];
    expect(line).toContain('/api/whatsapp/messages');
    expect(line).not.toContain('919876543210');
  });

  it('does not try to answer twice when the response already started', () => {
    res.headersSent = true;
    filter.catch(new Error('stream broke'), hostFor());
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
