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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideosModule } from '../src/videos/videos.module';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;
  let storageService: StorageService;
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
    storageService = moduleFixture.get(StorageService);
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

  async function createDraft(
    token: string,
    body: Record<string, unknown> = validBody,
  ): Promise<{ publicId: string; uploadId: string; storageKey: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body as {
      publicId: string;
      uploadId: string;
      storageKey: string;
    };
  }

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

  describe('POST /videos/:publicId/upload/part-urls', () => {
    it('returns presigned part URLs for the owner', async () => {
      const token = await registerConfirmAndLogin('owner1@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1, 2] })
        .expect(201);

      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ partNumber: 1 });
      expect(res.body[0].url).toMatch(/^https?:\/\//);
    });

    it('returns 403 for a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin('owner2@example.com');
      const draft = await createDraft(ownerToken);
      const otherToken = await registerConfirmAndLogin('intruder@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ partNumbers: [1] })
        .expect(403);

      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });

    it('returns 404 for an unknown publicId', async () => {
      const token = await registerConfirmAndLogin('owner3@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/doesNotExist/upload/part-urls')
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 when the video is already ready', async () => {
      const token = await registerConfirmAndLogin('owner4@example.com');
      const draft = await createDraft(token);
      await dataSource.query(
        `UPDATE "videos" SET status = 'ready' WHERE public_id = $1`,
        [draft.publicId],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(409);

      expect(res.body.error).toBe('UPLOAD_NOT_COMPLETABLE');
    });
  });

  describe('POST /videos/:publicId/upload/complete and /abort', () => {
    async function uploadOnePart(
      token: string,
      publicId: string,
    ): Promise<{ partNumber: number; eTag: string }> {
      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(201);
      const url = partsRes.body[0].url as string;
      const put = await fetch(url, {
        method: 'PUT',
        body: Buffer.from('hello-e2e-video'),
      });
      expect(put.status).toBe(200);
      return { partNumber: 1, eTag: put.headers.get('etag') as string };
    }

    it('completes the full upload and marks the video processing', async () => {
      const token = await registerConfirmAndLogin('uploader@example.com');
      const draft = await createDraft(token);
      const part = await uploadOnePart(token, draft.publicId);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] })
        .expect(200);

      expect(res.body.publicId).toBe(draft.publicId);
      expect(res.body.status).toBe('processing');
    });

    it('aborts an in-progress upload and removes the draft (204)', async () => {
      const token = await registerConfirmAndLogin('aborter@example.com');
      const draft = await createDraft(token);
      await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await dataSource.query(
        'SELECT id FROM "videos" WHERE public_id = $1',
        [draft.publicId],
      );
      expect(rows).toHaveLength(0);
    });

    it('returns 403 when a non-owner tries to complete', async () => {
      const ownerToken = await registerConfirmAndLogin('cowner@example.com');
      const draft = await createDraft(ownerToken);
      const otherToken = await registerConfirmAndLogin('cintruder@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'x' }] })
        .expect(403);

      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });
  });

  describe('GET /videos/:publicId', () => {
    async function makeReady(publicId: string): Promise<void> {
      await dataSource.query(
        `UPDATE "videos" SET status = 'ready', thumbnail_key = $2, duration_seconds = 10 WHERE public_id = $1`,
        [publicId, `videos/${publicId}/thumbnail.jpg`],
      );
    }

    it('returns 200 for a ready video anonymously (no owner-only fields)', async () => {
      const token = await registerConfirmAndLogin('getready@example.com');
      const draft = await createDraft(token);
      await makeReady(draft.publicId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.publicId}`)
        .expect(200);

      expect(res.body.publicId).toBe(draft.publicId);
      expect(res.body.status).toBe('ready');
      expect(res.body.thumbnailUrl).toBe(`/videos/${draft.publicId}/thumbnail`);
      expect(res.body.channel.nickname).toBeTruthy();
      expect(res.body.failureReason).toBeUndefined();
    });

    it('returns 404 for a draft requested anonymously', async () => {
      const token = await registerConfirmAndLogin('getdraft@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.publicId}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('lets the owner see their own draft', async () => {
      const token = await registerConfirmAndLogin('getownerdraft@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.publicId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.publicId).toBe(draft.publicId);
      expect(res.body.status).toBe('draft');
    });
  });

  describe('GET /videos', () => {
    it('lists only the caller channel videos and requires auth', async () => {
      const tokenA = await registerConfirmAndLogin('listA@example.com');
      await createDraft(tokenA, { ...validBody, filename: 'a1.mp4' });
      await createDraft(tokenA, { ...validBody, filename: 'a2.mp4' });
      const tokenB = await registerConfirmAndLogin('listB@example.com');
      await createDraft(tokenB, { ...validBody, filename: 'b1.mp4' });

      const res = await request(app.getHttpServer())
        .get('/videos')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.page).toBe(1);

      await request(app.getHttpServer()).get('/videos').expect(401);
    });
  });

  describe('GET /videos/:publicId/stream, /download, /thumbnail', () => {
    const VIDEO_SIZE = 2048;

    async function setupReadyVideo(token: string): Promise<string> {
      const draft = await createDraft(token);
      // Put a known object at the video's storage key + a thumbnail, then mark it ready.
      await storageService.putObject(
        draft.storageKey,
        Buffer.alloc(VIDEO_SIZE, 1),
        'video/mp4',
      );
      const rows = (await dataSource.query(
        'SELECT id FROM "videos" WHERE public_id = $1',
        [draft.publicId],
      )) as Array<{ id: string }>;
      const thumbnailKey = `videos/${rows[0].id}/thumbnail.jpg`;
      await storageService.putObject(
        thumbnailKey,
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        'image/jpeg',
      );
      await dataSource.query(
        `UPDATE "videos" SET status = 'ready', thumbnail_key = $2, duration_seconds = 5 WHERE public_id = $1`,
        [draft.publicId, thumbnailKey],
      );
      return draft.publicId;
    }

    it('streams a byte range as 206 Partial Content', async () => {
      const token = await registerConfirmAndLogin('streamer@example.com');
      const publicId = await setupReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-1023/${VIDEO_SIZE}`);
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('streams the full object as 200 with Accept-Ranges when no Range is sent', async () => {
      const token = await registerConfirmAndLogin('streamfull@example.com');
      const publicId = await setupReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(VIDEO_SIZE));
    });

    it('returns 416 for an unsatisfiable range', async () => {
      const token = await registerConfirmAndLogin('streambad@example.com');
      const publicId = await setupReadyVideo(token);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=999999-')
        .expect(416);
    });

    it('downloads the video as an attachment', async () => {
      const token = await registerConfirmAndLogin('downloader@example.com');
      const publicId = await setupReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
    });

    it('returns the JPEG thumbnail', async () => {
      const token = await registerConfirmAndLogin('thumbnailer@example.com');
      const publicId = await setupReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/thumbnail`)
        .expect(200);

      expect(res.headers['content-type']).toContain('image/jpeg');
    });

    it('returns 409 VIDEO_NOT_READY when streaming a non-ready video', async () => {
      const token = await registerConfirmAndLogin('notready@example.com');
      const draft = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.publicId}/stream`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });
});
