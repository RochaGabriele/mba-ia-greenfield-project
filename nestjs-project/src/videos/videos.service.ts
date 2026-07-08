import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { customAlphabet } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenVideoAccessException,
  UploadNotCompletableException,
  UploadTooLargeException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';

const PUBLIC_ID_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PUBLIC_ID_LENGTH = 11;
const generatePublicId = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH);

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PUBLIC_ID_RETRIES = 5;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface CreateDraftResult {
  publicId: string;
  uploadId: string;
  storageKey: string;
  partSize: number;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-register a video as a draft and initiate its multipart upload. The bytes never pass
   * through the API — the client uploads parts directly to storage using presigned URLs (TD-02).
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    const maxBytes = this.storage.maxUploadSizeGb * BYTES_PER_GB;
    if (dto.sizeBytes > maxBytes) {
      throw new UploadTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Invariant: every authenticated user has a channel (created at registration).
      throw new Error(`No channel found for user ${userId}`);
    }

    const id = randomUUID();
    const filename = this.sanitizeFilename(dto.filename);
    const storageKey = `videos/${id}/original/${filename}`;

    const { uploadId } =
      await this.storageService.createMultipartUpload(storageKey);

    const video = await this.persistDraft({
      id,
      channelId: channel.id,
      title: dto.title,
      filename,
      storageKey,
      sizeBytes: dto.sizeBytes,
      uploadId,
    });

    return {
      publicId: video.public_id,
      uploadId,
      storageKey,
      partSize: this.storage.uploadPartSizeMb * BYTES_PER_MB,
      status: video.status,
    };
  }

  /**
   * Return presigned PUT URLs for the requested part numbers so the client uploads each part
   * directly to storage. Owner-only; the first call transitions the video draft → uploading.
   */
  async presignParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<Array<{ partNumber: number; url: string }>> {
    const video = await this.loadOwnedVideo(userId, publicId);

    const uploadId = video.upload_id;
    if (
      (video.status !== VideoStatus.DRAFT &&
        video.status !== VideoStatus.UPLOADING) ||
      !uploadId
    ) {
      throw new UploadNotCompletableException();
    }

    if (video.status === VideoStatus.DRAFT) {
      await this.videoRepository.update(
        { id: video.id },
        { status: VideoStatus.UPLOADING },
      );
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
        ),
      })),
    );
  }

  /** Load a video by public_id and assert the caller owns it (via their channel). */
  private async loadOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new ForbiddenVideoAccessException();
    }
    return video;
  }

  /** Insert the draft row, regenerating the public_id on the (astronomically rare) collision. */
  private async persistDraft(params: {
    id: string;
    channelId: string;
    title: string;
    filename: string;
    storageKey: string;
    sizeBytes: number;
    uploadId: string;
  }): Promise<Video> {
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: params.id,
            public_id: generatePublicId(),
            channel_id: params.channelId,
            title: params.title,
            status: VideoStatus.DRAFT,
            original_filename: params.filename,
            storage_key: params.storageKey,
            size_bytes: params.sizeBytes,
            upload_id: params.uploadId,
          }),
        );
      } catch (err) {
        if (
          this.isPublicIdCollision(err) &&
          attempt < MAX_PUBLIC_ID_RETRIES - 1
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique public_id after retries');
  }

  private isPublicIdCollision(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const e = err as { code?: string; detail?: string };
    return (
      e.code === PG_UNIQUE_VIOLATION &&
      typeof e.detail === 'string' &&
      e.detail.includes('public_id')
    );
  }

  private sanitizeFilename(filename: string): string {
    const cleaned = filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_');
    return cleaned.slice(0, 255) || 'file';
  }
}
