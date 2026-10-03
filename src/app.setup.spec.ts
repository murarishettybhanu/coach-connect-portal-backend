import { assertRequiredEnv, corsOrigins } from './app.setup';

describe('assertRequiredEnv', () => {
  const base = { MONGODB_URI: 'mongodb://localhost/x', JWT_SECRET: 's' };

  it('passes with the required variables set', () => {
    expect(() => assertRequiredEnv({ ...base })).not.toThrow();
  });

  it('names every missing variable at once', () => {
    expect(() => assertRequiredEnv({})).toThrow(/MONGODB_URI, JWT_SECRET/);
  });

  it('treats a blank value as missing', () => {
    expect(() => assertRequiredEnv({ ...base, JWT_SECRET: '  ' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('requires a CORS allowlist in production', () => {
    expect(() =>
      assertRequiredEnv({ ...base, NODE_ENV: 'production' }),
    ).toThrow(/CORS_ORIGINS/);
    expect(() =>
      assertRequiredEnv({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://tribemerchandise.com',
      }),
    ).not.toThrow();
  });

  it('does not need one in development', () => {
    expect(() => assertRequiredEnv({ ...base })).not.toThrow();
  });
});

describe('corsOrigins', () => {
  it('splits and trims the configured list', () => {
    expect(
      corsOrigins({
        CORS_ORIGINS: ' https://a.com , https://b.com,, ',
      }),
    ).toEqual(['https://a.com', 'https://b.com']);
  });
});
