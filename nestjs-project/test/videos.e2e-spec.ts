import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideosModule } from '../src/videos/videos.module';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      // VideosModule is not wired into AppModule until SI-03.11; importing it here
      // (alongside AppModule) exercises the video routes with the real global guards.
      imports: [AppModule, VideosModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    authService = moduleFixture.get(AuthService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailService = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  const validBody = {
    title: 'My Video',
    filename: 'clip.mp4',
    sizeBytes: 5_000_000,
    contentType: 'video/mp4',
  };

  describe('POST /videos', () => {
    it('creates a draft and returns upload coordinates for an authenticated user', async () => {
      const token = await registerConfirmAndLogin('creator@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody)
        .expect(201);

      expect(res.body.publicId).toHaveLength(11);
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.storageKey).toMatch(/^videos\/.+\/original\/clip\.mp4$/);
      expect(res.body.partSize).toBeGreaterThan(0);
      expect(res.body.status).toBe('draft');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('returns 400 on an invalid body', async () => {
      const token = await registerConfirmAndLogin('badbody@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: 'clip.mp4' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 413 UPLOAD_TOO_LARGE when sizeBytes exceeds the limit', async () => {
      const token = await registerConfirmAndLogin('toobig@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, sizeBytes: MAX_UPLOAD_SIZE_BYTES + 1 })
        .expect(413);

      expect(res.body.error).toBe('UPLOAD_TOO_LARGE');
    });
  });
});
