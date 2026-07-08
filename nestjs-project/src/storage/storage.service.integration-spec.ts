import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let app: INestApplication;
  let service: StorageService;
  const createdPrefixes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // app.init() drives onModuleInit → ensureBucket against the real MinIO service.
    await app.init();
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const prefix of createdPrefixes) {
      await service.deletePrefix(prefix);
    }
    await app.close();
  });

  function trackedPrefix(): string {
    const prefix = `test/${randomUUID()}/`;
    createdPrefixes.push(prefix);
    return prefix;
  }

  it('ensureBucket is idempotent (safe to call when the bucket already exists)', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('round-trips an object through presigned multipart upload', async () => {
    const key = `${trackedPrefix()}original.bin`;
    const payload = Buffer.from('hello-multipart-world');

    const { uploadId } = await service.createMultipartUpload(key);
    expect(uploadId).toBeTruthy();

    const url = await service.presignUploadPart(key, uploadId, 1);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('partNumber=1');

    // The client uploads the part directly to MinIO via the presigned URL.
    const putRes = await fetch(url, { method: 'PUT', body: payload });
    expect(putRes.status).toBe(200);
    const eTag = putRes.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(payload.length);

    const full = await service.getObjectRange(key);
    const body = await streamToBuffer(full.stream);
    expect(body.toString()).toBe('hello-multipart-world');
  });

  it('getObjectRange returns exactly the requested byte window with Content-Range', async () => {
    const key = `${trackedPrefix()}alphabet.txt`;
    const payload = Buffer.from('abcdefghijklmnopqrstuvwxyz'); // 26 bytes

    await service.putObject(key, payload, 'text/plain');

    const ranged = await service.getObjectRange(key, 'bytes=0-9');
    expect(ranged.contentLength).toBe(10);
    expect(ranged.contentRange).toBe('bytes 0-9/26');

    const bytes = await streamToBuffer(ranged.stream);
    expect(bytes.length).toBe(10);
    expect(bytes.toString()).toBe('abcdefghij');
  });

  it('putObject then headObject reports the size and content type', async () => {
    const key = `${trackedPrefix()}thumb.jpg`;
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await service.putObject(key, payload, 'image/jpeg');

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(payload.length);
    expect(head.contentType).toBe('image/jpeg');
  });

  it('deletePrefix removes every object under the prefix (original + thumbnail)', async () => {
    const prefix = `test/${randomUUID()}/`;
    const originalKey = `${prefix}original/video.bin`;
    const thumbKey = `${prefix}thumbnail.jpg`;

    await service.putObject(
      originalKey,
      Buffer.from('video-bytes'),
      'application/octet-stream',
    );
    await service.putObject(thumbKey, Buffer.from('thumb-bytes'), 'image/jpeg');

    await service.deletePrefix(prefix);

    await expect(service.headObject(originalKey)).rejects.toThrow();
    await expect(service.headObject(thumbKey)).rejects.toThrow();
  });
});
