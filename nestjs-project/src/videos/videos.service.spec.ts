import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { UploadTooLargeException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: { create: jest.Mock; save: jest.Mock };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: { createMultipartUpload: jest.Mock };

  beforeEach(async () => {
    videoRepo = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) => Promise.resolve(v)),
    };
    channelsService = { findByUserId: jest.fn() };
    storageService = { createMultipartUpload: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
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
      (collision as unknown as { code: string; detail: string }).code =
        '23505';
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
});
