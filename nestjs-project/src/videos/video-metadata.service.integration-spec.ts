import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import ffmpeg from 'fluent-ffmpeg';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { VideoMetadataService } from './video-metadata.service';

async function makeSampleVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-sample-'));
  const file = join(dir, 'sample.mp4');
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input('testsrc=duration=2:size=320x240:rate=15')
        .inputFormat('lavfi')
        .outputOptions(['-pix_fmt yuv420p', '-movflags +faststart'])
        .save(file)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('VideoMetadataService (integration)', () => {
  let app: INestApplication;
  let metadataService: VideoMetadataService;
  let storageService: StorageService;
  const testPrefix = `test/${randomUUID()}/`;
  const storageKey = `${testPrefix}sample.mp4`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [VideoMetadataService],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    metadataService = moduleRef.get(VideoMetadataService);
    storageService = moduleRef.get(StorageService);

    await storageService.putObject(
      storageKey,
      await makeSampleVideo(),
      'video/mp4',
    );
  }, 60000);

  afterAll(async () => {
    await storageService.deletePrefix(testPrefix);
    await app.close();
  });

  it('probes a plausible duration and resolution from a video in storage', async () => {
    const url = await storageService.presignGetObject(storageKey);

    const meta = await metadataService.probe(url);

    expect(meta.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(meta.durationSeconds).toBeLessThanOrEqual(3);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.codec).toBeTruthy();
  });

  it('generates a valid JPEG thumbnail', async () => {
    const url = await storageService.presignGetObject(storageKey);

    const thumb = await metadataService.generateThumbnail(url);

    expect(thumb.length).toBeGreaterThan(0);
    // JPEG magic bytes: FF D8 FF
    expect(thumb[0]).toBe(0xff);
    expect(thumb[1]).toBe(0xd8);
    expect(thumb[2]).toBe(0xff);
  });
});
