import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const isProd = process.env.NODE_ENV === 'production';

  // Trust the single reverse proxy (Caddy) so req.ip reflects the real client
  // IP from X-Forwarded-For — required for correct per-IP rate limiting.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Security headers.
  app.use(helmet());

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  // Lock CORS to configured frontend origins in production; open in dev.
  const origins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : true,
    credentials: true,
  });

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
bootstrap();
