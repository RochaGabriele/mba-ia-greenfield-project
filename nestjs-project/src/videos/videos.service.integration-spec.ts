import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let app: INestApplication;
  let service: VideosService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  const uploadsToAbort: Array<{ key: string; uploadId: string }> = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    service = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    for (const u of uploadsToAbort) {
      await storageService
        .abortMultipartUpload(u.key, u.uploadId)
        .catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE "videos", "channels", "users" CASCADE',
    );
  });

  let counter = 0;
  async function createChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `Chan ${counter}`,
        nickname: `vsvc_chan_${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  it('persists a draft video and initiates a real multipart upload in MinIO', async () => {
    const { userId, channelId } = await createChannel();

    const result = await service.createDraft(userId, {
      title: 'Integration clip',
      filename: 'clip one.mp4',
      sizeBytes: 5_000_000,
    });
    uploadsToAbort.push({ key: result.storageKey, uploadId: result.uploadId });

    expect(result.publicId).toHaveLength(11);
    expect(result.uploadId).toBeTruthy();
    expect(result.storageKey).toMatch(
      /^videos\/[0-9a-f-]+\/original\/clip_one\.mp4$/,
    );
    expect(result.status).toBe(VideoStatus.DRAFT);

    const video = await videoRepo.findOneByOrFail({
      public_id: result.publicId,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.channel_id).toBe(channelId);
    expect(video.upload_id).toBe(result.uploadId);
    expect(video.storage_key).toBe(result.storageKey);
    expect(video.size_bytes).toBe(5_000_000);

    // Prove the multipart upload really exists: a presigned part PUT succeeds.
    const url = await storageService.presignUploadPart(
      result.storageKey,
      result.uploadId,
      1,
    );
    const put = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('part-bytes'),
    });
    expect(put.status).toBe(200);
  });

  it('assigns a distinct unique public_id to each draft', async () => {
    const { userId } = await createChannel();

    const a = await service.createDraft(userId, {
      title: 'A',
      filename: 'a.mp4',
      sizeBytes: 1000,
    });
    const b = await service.createDraft(userId, {
      title: 'B',
      filename: 'b.mp4',
      sizeBytes: 1000,
    });
    uploadsToAbort.push({ key: a.storageKey, uploadId: a.uploadId });
    uploadsToAbort.push({ key: b.storageKey, uploadId: b.uploadId });

    expect(a.publicId).not.toBe(b.publicId);
    expect(await videoRepo.count()).toBe(2);
  });

  it('presignParts returns working part URLs and moves the draft to uploading', async () => {
    const { userId } = await createChannel();
    const draft = await service.createDraft(userId, {
      title: 'T',
      filename: 'v.mp4',
      sizeBytes: 5_000_000,
    });
    uploadsToAbort.push({ key: draft.storageKey, uploadId: draft.uploadId });

    const urls = await service.presignParts(userId, draft.publicId, [1, 2]);
    expect(urls).toHaveLength(2);
    expect(urls.map((u) => u.partNumber)).toEqual([1, 2]);

    for (const { url } of urls) {
      const put = await fetch(url, {
        method: 'PUT',
        body: Buffer.from('x'.repeat(1024)),
      });
      expect(put.status).toBe(200);
    }

    const video = await videoRepo.findOneByOrFail({
      public_id: draft.publicId,
    });
    expect(video.status).toBe(VideoStatus.UPLOADING);
  });
});
