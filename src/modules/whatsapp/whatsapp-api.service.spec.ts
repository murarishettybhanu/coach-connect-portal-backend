import {
  BadGatewayException,
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  WhatsappApiService,
  isMetaMediaUrl,
  MAX_MEDIA_BYTES,
} from './whatsapp-api.service';

/**
 * Meta enforces the 20-character `parameter_name` cap on SEND, not on template
 * creation — `weekly_dispatch_report` was approved with a 22-character name and
 * then failed every send. These pin the guard that catches it first.
 */
describe('WhatsappApiService parameter-name guard', () => {
  const api = new WhatsappApiService();
  const fetchSpy = jest.spyOn(global, 'fetch');

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('rejects an over-long body parameter without calling Meta', async () => {
    await expect(
      api.sendTemplate('919000000000', {
        name: 'weekly_dispatch_report',
        language: 'en',
        namedParameters: { weekly_product_summary: 'x' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names the offending parameter and its length', async () => {
    await expect(
      api.sendTemplate('919000000000', {
        name: 'weekly_dispatch_report',
        language: 'en',
        namedParameters: { weekly_product_summary: 'x' },
      }),
    ).rejects.toThrow(/"weekly_product_summary" \(22\)/);
  });

  it('catches an over-long header parameter too', async () => {
    await expect(
      api.sendTemplate('919000000000', {
        name: 'some_template',
        language: 'en',
        headerNamedParameters: { extremely_long_header_name: 'x' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows names at exactly the limit', async () => {
    const twenty = 'a'.repeat(20);
    expect(twenty).toHaveLength(20);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] })),
    } as unknown as Response);
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';

    const res = await api.sendTemplate('919000000000', {
      name: 'ok_template',
      language: 'en',
      namedParameters: { [twenty]: 'x' },
    });
    expect(res.waMessageId).toBe('wamid.TEST');
    expect(fetchSpy).toHaveBeenCalled();
  });
});

/** A minimal fetch Response for the mocks below. */
function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.from(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(text),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('WhatsappApiService media proxy', () => {
  const api = new WhatsappApiService();
  // Spied per block: a spy made at collection time would be the same object
  // the block above restores, and these would then hit the real Graph API.
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  beforeAll(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  });
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('only treats https Meta CDN hosts as media hosts', () => {
    expect(
      isMetaMediaUrl(
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      ),
    ).toBe(true);
    expect(isMetaMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isMetaMediaUrl('https://evil.example.com/x')).toBe(false);
    // Suffix, not substring.
    expect(isMetaMediaUrl('https://fbsbx.com.evil.example/x')).toBe(false);
    expect(isMetaMediaUrl('not a url')).toBe(false);
  });

  it('refuses a non-numeric media id without calling Meta', async () => {
    await expect(api.downloadMedia('../me/accounts')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never sends the token to a host outside Meta', async () => {
    fetchSpy.mockResolvedValueOnce(
      response(200, {
        url: 'https://evil.example.com/steal',
        mime_type: 'image/jpeg',
      }),
    );
    await expect(api.downloadMedia('123')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    // Only the Graph lookup went out.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect off the Meta hosts', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response(200, { url: 'https://lookaside.fbsbx.com/m?mid=1' }),
      )
      .mockResolvedValueOnce(
        response(302, '', { location: 'https://evil.example.com/x' }),
      );
    await expect(api.downloadMedia('123')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('downloads media from the Meta CDN', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response(200, {
          url: 'https://lookaside.fbsbx.com/m?mid=1',
          mime_type: 'image/jpeg',
        }),
      )
      .mockResolvedValueOnce(response(200, 'jpeg-bytes'));

    const media = await api.downloadMedia('123');
    expect(media.mimeType).toBe('image/jpeg');
    expect(media.buffer.toString()).toBe('jpeg-bytes');
  });

  it('refuses media declared larger than the cap', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response(200, { url: 'https://lookaside.fbsbx.com/m?mid=1' }),
      )
      .mockResolvedValueOnce(
        response(200, 'x', { 'content-length': String(MAX_MEDIA_BYTES + 1) }),
      );
    await expect(api.downloadMedia('123')).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });
});

describe('WhatsappApiService upstream errors', () => {
  const api = new WhatsappApiService();
  // Spied per block: a spy made at collection time would be the same object
  // the block above restores, and these would then hit the real Graph API.
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  beforeAll(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  const graphError = {
    error: { message: 'Internal detail about WABA 1234', code: 131047 },
  };

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  });
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  const send = () =>
    api.sendText('919000000000', 'hello').catch((e: unknown) => e);

  it("keeps Meta's wording out of the response but on the error for the inbox", async () => {
    fetchSpy.mockResolvedValueOnce(response(400, graphError));
    const err = (await send()) as BadRequestException & {
      upstreamDetail?: string;
    };

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toContain('WABA');
    expect(err.message).toContain('131047');
    expect(err.upstreamDetail).toContain('Internal detail about WABA 1234');
  });

  it.each([401, 403])('maps an upstream %i to 503, not 400', async (status) => {
    fetchSpy.mockResolvedValueOnce(response(status, graphError));
    expect(await send()).toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps an upstream 5xx to 502', async () => {
    fetchSpy.mockResolvedValueOnce(response(500, graphError));
    const err = (await send()) as Error;
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).not.toContain('WABA');
  });

  it('does not echo a network failure reason', async () => {
    fetchSpy.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:443'),
    );
    const err = (await send()) as Error;
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).not.toContain('10.0.0.5');
  });
});
