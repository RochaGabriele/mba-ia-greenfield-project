import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE "videos", "channels", "users" CASCADE',
    );
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Chan ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: `pub_${++counter}`,
      channel_id: channel.id,
      title: 'My Video',
      original_filename: 'clip.mp4',
      storage_key: `videos/${counter}/original/clip.mp4`,
      ...overrides,
    });
  }

  it('defaults status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel));
    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('enforces the unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel, { public_id: 'dupPublic01' }),
    );
    await expect(
      videoRepository.save(buildVideo(channel, { public_id: 'dupPublic01' })),
    ).rejects.toThrow();
  });

  it('enforces the channel_id foreign key', async () => {
    const channel = await createChannel();
    const orphan = buildVideo(channel, {
      channel_id: '00000000-0000-0000-0000-000000000000',
    });
    await expect(videoRepository.save(orphan)).rejects.toThrow();
  });

  it('accepts null for all optional columns', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel, {
        thumbnail_key: null,
        upload_id: null,
        size_bytes: null,
        duration_seconds: null,
        metadata: null,
        failure_reason: null,
      }),
    );
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.failure_reason).toBeNull();
  });

  it('auto-populates created_at and updated_at', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel));
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('round-trips jsonb metadata and 10GB bigint size_bytes as a number', async () => {
    const channel = await createChannel();
    const tenGb = 10 * 1024 * 1024 * 1024;
    const saved = await videoRepository.save(
      buildVideo(channel, {
        size_bytes: tenGb,
        duration_seconds: 120,
        metadata: { width: 1920, height: 1080, codec: 'h264' },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGb);
    expect(typeof found.size_bytes).toBe('number');
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
    });
  });
});
