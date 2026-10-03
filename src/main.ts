import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { assertRequiredEnv, configureApp } from './app.setup';

async function bootstrap() {
  // ConfigModule loads `.env` while AppModule is imported; wait for it so the
  // check below sees the same variables the app will.
  await ConfigModule.envVariablesLoaded;
  assertRequiredEnv();

  // `rawBody` keeps the untouched request bytes around (as `req.rawBody`) so the
  // WhatsApp webhook can verify Meta's X-Hub-Signature-256 HMAC, which is
  // computed over the exact payload — re-serialized JSON would not match.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const isProd = process.env.NODE_ENV === 'production';

  configureApp(app);

  // Swagger docs — never expose the full API surface in production.
  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle('Tribe Merchandise API')
      .setDescription('Backend API for the Tribe Merchandise platform')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT || 3000);
}

bootstrap().catch((err: Error) => {
  // A half-started server is worse than none: the deploy's health gate should
  // see the container exit and roll back.
  new Logger('Bootstrap').error(
    `Startup failed: ${err?.message ?? err}`,
    err?.stack,
  );
  process.exit(1);
});
