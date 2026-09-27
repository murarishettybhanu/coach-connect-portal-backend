import { BadRequestException } from '@nestjs/common';
import { WhatsappApiService } from './whatsapp-api.service';

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
