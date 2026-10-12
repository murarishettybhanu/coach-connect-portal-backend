import { ServiceUnavailableException } from '@nestjs/common';
import { IndiaPostApiService } from './india-post-api.service';

const json = (status: number, body: unknown) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  }) as Response;

const loginOk = () =>
  json(200, { success: true, data: { access_token: 'tok', expires_in: 1800 } });

describe('IndiaPostApiService', () => {
  const env = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.INDIAPOST_USERNAME = 'user';
    process.env.INDIAPOST_PASSWORD = 'pass';
    delete process.env.INDIAPOST_BASE_URL;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterAll(() => {
    process.env = env;
  });

  it('defaults to the production host', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(json(200, { data: [] }));
    await new IndiaPostApiService().trackBulk(['CA187141418IN']);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://app.indiapost.gov.in/beextcustomer/v1/access/login',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://app.indiapost.gov.in/beextcustomer/v1/tracking/bulk',
    );
  });

  it("a 403 after a fresh login means the API isn't enabled for our account", async () => {
    const denied = json(403, {
      success: false,
      error: { message: 'You are not authorized to access this API' },
    });
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(denied)
      // Retries once with a new token before giving up.
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(denied);
    const err = await new IndiaPostApiService()
      .trackBulk(['CA187141418IN'])
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toMatch("hasn't enabled this API for our account");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a 401 still reads as rejected credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(json(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(json(401, { message: 'Unauthorized' }));
    const err = await new IndiaPostApiService()
      .trackBulk(['CA187141418IN'])
      .catch((e) => e);
    expect(err.message).toMatch('rejected our credentials');
  });
});
