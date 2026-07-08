import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenVideoAccessException,
  UploadNotCompletableException,
  UploadTooLargeException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let videoQueueService: { enqueueProcessing: jest.Mock };

  beforeEach(async () => {
    videoRepo = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    channelsService = { findByUserId: jest.fn() };
    storageService = {
      createMultipartUpload: jest.fn(),
      presignUploadPart: jest.fn(),
      completeMultipartUpload: jest.fn(() => Promise.resolve()),
      abortMultipartUpload: jest.fn(() => Promise.resolve()),
    };
    videoQueueService = { enqueueProcessing: jest.fn(() => Promise.resolve()) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoQueueService, useValue: videoQueueService },
        {
          provide: storageConfig.KEY,
          useValue: { maxUploadSizeGb: 10, uploadPartSizeMb: 100 },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('generates a public_id, computes the key, initiates multipart, and persists a draft', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
      });

      const result = await service.createDraft('user-1', {
        title: 'My clip',
        filename: 'my clip!.mp4',
        sizeBytes: 1000,
      });

      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(1);
      const keyArg = storageService.createMultipartUpload.mock
        .calls[0][0] as string;
      expect(keyArg).toMatch(/^videos\/[0-9a-f-]+\/original\/my_clip_\.mp4$/);

      expect(videoRepo.save).toHaveBeenCalledTimes(1);
      const saved = videoRepo.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('channel-1');
      expect(saved.upload_id).toBe('upload-1');
      expect(saved.storage_key).toBe(keyArg);
      expect(saved.size_bytes).toBe(1000);
      expect(saved.public_id).toHaveLength(11);

      expect(result).toMatchObject({
        uploadId: 'upload-1',
        storageKey: keyArg,
        partSize: 100 * 1024 * 1024,
        status: VideoStatus.DRAFT,
      });
      expect(result.publicId).toHaveLength(11);
    });

    it('rejects an oversized upload with 413 before touching storage', async () => {
      const tooBig = 10 * 1024 * 1024 * 1024 + 1;

      await expect(
        service.createDraft('user-1', {
          title: 't',
          filename: 'f.mp4',
          sizeBytes: tooBig,
        }),
      ).rejects.toBeInstanceOf(UploadTooLargeException);

      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepo.save).not.toHaveBeenCalled();
    });

    it('retries public_id generation on a unique-violation collision', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
      });

      const collision = new QueryFailedError('INSERT', undefined, new Error());
      (collision as unknown as { code: string; detail: string }).code = '23505';
      (collision as unknown as { code: string; detail: string }).detail =
        'Key (public_id)=(abc) already exists.';
      videoRepo.save
        .mockRejectedValueOnce(collision)
        .mockImplementation((v: Video) => Promise.resolve(v));

      const result = await service.createDraft('user-1', {
        title: 't',
        filename: 'f.mp4',
        sizeBytes: 1000,
      });

      expect(videoRepo.save).toHaveBeenCalledTimes(2);
      expect(result.publicId).toHaveLength(11);
    });
  });

  describe('presignParts', () => {
    it('throws VideoNotFoundException for an unknown publicId', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.presignParts('user-1', 'unknown', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws ForbiddenVideoAccessException when the caller does not own the video', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'other-channel',
        status: VideoStatus.DRAFT,
        upload_id: 'u1',
        storage_key: 'k',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'my-channel' });

      await expect(
        service.presignParts('user-1', 'pub', [1]),
      ).rejects.toBeInstanceOf(ForbiddenVideoAccessException);
    });

    it('throws UploadNotCompletableException when the video is not draft/uploading', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c1',
        status: VideoStatus.READY,
        upload_id: 'u1',
        storage_key: 'k',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      await expect(
        service.presignParts('user-1', 'pub', [1]),
      ).rejects.toBeInstanceOf(UploadNotCompletableException);
    });

    it('transitions draft→uploading and returns one URL per requested part', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c1',
        status: VideoStatus.DRAFT,
        upload_id: 'u1',
        storage_key: 'videos/x/original/f.mp4',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });
      storageService.presignUploadPart.mockImplementation(
        (_k: string, _u: string, n: number) =>
          Promise.resolve(`https://minio/part-${n}`),
      );

      const urls = await service.presignParts('user-1', 'pub', [1, 2, 3]);

      expect(videoRepo.update).toHaveBeenCalledWith(
        { id: 'v1' },
        { status: VideoStatus.UPLOADING },
      );
      expect(urls).toEqual([
        { partNumber: 1, url: 'https://minio/part-1' },
        { partNumber: 2, url: 'https://minio/part-2' },
        { partNumber: 3, url: 'https://minio/part-3' },
      ]);
    });

    it('does not re-transition a video that is already uploading', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c1',
        status: VideoStatus.UPLOADING,
        upload_id: 'u1',
        storage_key: 'k',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });
      storageService.presignUploadPart.mockResolvedValue('https://minio/part');

      await service.presignParts('user-1', 'pub', [1]);

      expect(videoRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const uploadingVideo = {
      id: 'v1',
      public_id: 'pub123abc12',
      channel_id: 'c1',
      status: VideoStatus.UPLOADING,
      upload_id: 'u1',
      storage_key: 'videos/v1/original/f.mp4',
    };

    it('completes the upload, sets processing, clears upload_id, and enqueues the job', async () => {
      videoRepo.findOne.mockResolvedValue({ ...uploadingVideo });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      const result = await service.completeUpload('user-1', 'pub', [
        { partNumber: 1, eTag: 'etag-1' },
      ]);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/v1/original/f.mp4',
        'u1',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );
      expect(videoRepo.update).toHaveBeenCalledWith(
        { id: 'v1' },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith('v1');
      expect(result).toEqual({
        publicId: 'pub123abc12',
        status: VideoStatus.PROCESSING,
      });
    });

    it('throws UploadNotCompletableException when the video is not uploading', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...uploadingVideo,
        status: VideoStatus.DRAFT,
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      await expect(
        service.completeUpload('user-1', 'pub', [{ partNumber: 1, eTag: 'e' }]),
      ).rejects.toBeInstanceOf(UploadNotCompletableException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('throws ForbiddenVideoAccessException when the caller does not own the video', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...uploadingVideo,
        channel_id: 'other',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      await expect(
        service.completeUpload('user-1', 'pub', [{ partNumber: 1, eTag: 'e' }]),
      ).rejects.toBeInstanceOf(ForbiddenVideoAccessException);
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and removes the draft', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c1',
        status: VideoStatus.UPLOADING,
        upload_id: 'u1',
        storage_key: 'k',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      await service.abortUpload('user-1', 'pub');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'k',
        'u1',
      );
      expect(videoRepo.delete).toHaveBeenCalledWith({ id: 'v1' });
    });

    it('throws UploadNotCompletableException when the video is already processing', async () => {
      videoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c1',
        status: VideoStatus.PROCESSING,
        upload_id: 'u1',
        storage_key: 'k',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      await expect(service.abortUpload('user-1', 'pub')).rejects.toBeInstanceOf(
        UploadNotCompletableException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('getByPublicId', () => {
    const readyVideo = {
      public_id: 'pub_ready',
      title: 'Ready',
      status: VideoStatus.READY,
      duration_seconds: 42,
      thumbnail_key: 'videos/v1/thumbnail.jpg',
      channel_id: 'c1',
      channel: { nickname: 'creator' },
      created_at: new Date('2026-01-01'),
      metadata: { width: 1920 },
      failure_reason: null,
    };

    it('maps a ready video to the public view for anyone (no owner fields)', async () => {
      videoRepo.findOne.mockResolvedValue({ ...readyVideo });

      const view = await service.getByPublicId('pub_ready', null);

      expect(view).toMatchObject({
        publicId: 'pub_ready',
        title: 'Ready',
        status: VideoStatus.READY,
        durationSeconds: 42,
        thumbnailUrl: '/videos/pub_ready/thumbnail',
        channel: { nickname: 'creator' },
      });
      expect(view.metadata).toBeUndefined();
      expect(view.failureReason).toBeUndefined();
    });

    it('throws VideoNotFoundException for an unknown publicId', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.getByPublicId('nope', null)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a non-ready video from a non-owner (404)', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...readyVideo,
        status: VideoStatus.PROCESSING,
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'other' });

      await expect(
        service.getByPublicId('pub', 'user-x'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('shows a non-ready video to its owner with owner-only fields', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...readyVideo,
        status: VideoStatus.ERROR,
        failure_reason: 'boom',
      });
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });

      const view = await service.getByPublicId('pub', 'owner');

      expect(view.status).toBe(VideoStatus.ERROR);
      expect(view.failureReason).toBe('boom');
      expect(view.metadata).toEqual({ width: 1920 });
    });
  });

  describe('listOwn', () => {
    it('returns the caller channel videos, newest first, paginated', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'c1' });
      videoRepo.findAndCount.mockResolvedValue([
        [
          {
            public_id: 'a',
            title: 'A',
            status: VideoStatus.READY,
            duration_seconds: null,
            thumbnail_key: null,
            channel: { nickname: 'creator' },
            created_at: new Date(),
            metadata: null,
            failure_reason: null,
          },
        ],
        1,
      ]);

      const result = await service.listOwn('user-1', 1, 20);

      expect(videoRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { channel_id: 'c1' },
          order: { created_at: 'DESC' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].publicId).toBe('a');
    });

    it('returns an empty page when the caller has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      const result = await service.listOwn('user-1', 1, 20);

      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
      expect(videoRepo.findAndCount).not.toHaveBeenCalled();
    });
  });
});
