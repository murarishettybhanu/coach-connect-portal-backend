import { Test, TestingModule } from '@nestjs/testing';
import { Body, Controller, INestApplication, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from './../src/app.controller';
import { AppService } from './../src/app.service';
import { configureApp } from './../src/app.setup';

// Stands in for the routes that take `@Body() x: any` (and for the webhook,
// which needs the raw bytes), without pulling in the whole AppModule — that
// would connect to MongoDB, and this suite must run without one.
@Controller('echo')
class EchoController {
  @Post()
  echo(
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): { body: unknown; raw: string | null } {
    return { body, raw: req.rawBody ? req.rawBody.toString('utf8') : null };
  }
}

/**
 * HTTP-level checks of the production pipeline (`configureApp`: /api prefix,
 * operator-key backstop, ValidationPipe, exception filter). Needs no database:
 * the app is built from AppController plus a local echo route, not AppModule.
 */
describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController, EchoController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api (GET)', () => {
    return request(app.getHttpServer())
      .get('/api')
      .expect(200)
      .expect('Hello World!');
  });

  it('/api/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('rejects a body carrying a Mongo operator with 400', () => {
    return request(app.getHttpServer())
      .post('/api/echo')
      .send({ name: 'x', $set: { role: 'ADMIN' } })
      .expect(400);
  });

  it('rejects a nested operator too', () => {
    return request(app.getHttpServer())
      .post('/api/echo')
      .send({ filter: { price: { $gt: 0 } } })
      .expect(400);
  });

  it('passes an ordinary body through, with the raw bytes still available', async () => {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .send(payload)
      .expect(201);
    expect(res.body.body).toEqual(payload);
    expect(JSON.parse(res.body.raw)).toEqual(payload);
  });

  it('answers unknown routes with the filter’s JSON 404', () => {
    return request(app.getHttpServer())
      .get('/api/nope?phone=919876543210')
      .expect(404)
      .expect((res) => {
        expect(res.body.statusCode).toBe(404);
      });
  });
});
