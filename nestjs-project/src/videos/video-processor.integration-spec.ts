import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoMetadataService } from './video-metadata.service';
import { VideoProcessor } from './video-processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function makeSampleVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-proc-'));
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

function fakeJob(videoId: string, attemptsMade = 0): Job<ProcessVideoJobData> {
  return {
    id: 'test-job',
    data: { videoId },
    opts: { attempts: 3 },
    attemptsMade,
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessor (integration)', () => {
  let app: INestApplication;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  let counter = 0;
  const prefixesToClean: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessor, VideoMetadataService],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    processor = moduleRef.get(VideoProcessor);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  }, 60000);

  afterAll(async () => {
    for (const prefix of prefixesToClean) {
      await storageService.deletePrefix(prefix).catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE "videos", "channels", "users" CASCADE',
    );
  });

  async function createChannel(): Promise<string> {
    const user = await userRepo.save(
      userRepo.create({
        email: `proc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `Chan ${counter}`,
        nickname: `proc_chan_${counter}`,
        user_id: user.id,
      }),
    );
    return channel.id;
  }

  async function insertVideo(
    channelId: string,
    overrides: Partial<Video>,
  ): Promise<Video> {
    return videoRepo.save(
      videoRepo.create({
        public_id: `proc_${++counter}`,
        channel_id: channelId,
        title: 'Processing target',
        status: VideoStatus.PROCESSING,
        original_filename: 'sample.mp4',
        storage_key: 'unset',
        ...overrides,
      }),
    );
  }

  it('drives an uploaded video to ready with duration, metadata, and a thumbnail', async () => {
    const channelId = await createChannel();
    const id = randomUUID();
    const storageKey = `videos/${id}/original/sample.mp4`;
    prefixesToClean.push(`videos/${id}/`);
    await storageService.putObject(
      storageKey,
      await makeSampleVideo(),
      'video/mp4',
    );
    await insertVideo(channelId, { id, storage_key: storageKey });

    await processor.process(fakeJob(id));

    const video = await videoRepo.findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(video.thumbnail_key).toBe(`videos/${id}/thumbnail.jpg`);
    expect(video.metadata).toMatchObject({ width: 320, height: 240 });

    const head = await storageService.headObject(`videos/${id}/thumbnail.jpg`);
    expect(head.contentType).toBe('image/jpeg');
  });

  it('marks the video error with a reason after processing fails permanently', async () => {
    const channelId = await createChannel();
    const id = randomUUID();
    // storage_key points at an object that does not exist → ffprobe fails.
    const video = await insertVideo(channelId, {
      id,
      storage_key: `videos/${id}/original/missing.mp4`,
    });

    const job = fakeJob(video.id, 3);
    await expect(processor.process(job)).rejects.toBeDefined();
    await processor.onFailed(job, new Error('ffprobe failed'));

    const updated = await videoRepo.findOneByOrFail({ id });
    expect(updated.status).toBe(VideoStatus.ERROR);
    expect(updated.failure_reason).toBe('ffprobe failed');
  });

  it('is a no-op when re-processing an already-ready video', async () => {
    const channelId = await createChannel();
    const id = randomUUID();
    await insertVideo(channelId, {
      id,
      status: VideoStatus.READY,
      storage_key: `videos/${id}/original/x.mp4`,
      thumbnail_key: `videos/${id}/thumbnail.jpg`,
      duration_seconds: 5,
    });

    await processor.process(fakeJob(id));

    const video = await videoRepo.findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBe(5);
  });
});
