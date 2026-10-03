import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RejectOperatorKeysPipe } from './common/pipes/reject-operator-keys.pipe';

// Without these the app can't do anything useful, and the failure it would hit
// later (a Mongoose connect error, a JwtStrategy throw) names the wrong cause.
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'] as const;

/**
 * Fails fast, naming every missing variable at once. In production the CORS
 * allowlist is required too: falling back to "any origin" there would let any
 * site make credentialed calls to the API.
 */
export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = REQUIRED_ENV.filter((key) => !env[key]?.trim());
  if (env.NODE_ENV === 'production' && !corsOrigins(env).length) {
    missing.push('CORS_ORIGINS');
  }
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}`,
    );
  }
}

/** Allowed frontend origins from `CORS_ORIGINS` (or the legacy `FRONTEND_URL`). */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGINS || env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Everything `main.ts` applies to the app besides listening — shared with the
 * e2e test so it exercises the same pipes, filter and prefix as production.
 */
export function configureApp(app: INestApplication): void {
  const isProd = process.env.NODE_ENV === 'production';

  // Trust the single reverse proxy (Caddy) so req.ip reflects the real client
  // IP from X-Forwarded-For — required for correct per-IP rate limiting.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Security headers.
  app.use(helmet());

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    // First, so an operator key is refused before anything else reads the body.
    new RejectOperatorKeysPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Lock CORS to configured frontend origins in production (assertRequiredEnv
  // guarantees there are some); open in dev so localhost / LAN dev servers
  // work without per-machine CORS config.
  app.enableCors({
    origin: isProd ? corsOrigins() : true,
    credentials: true,
  });
}
