import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { customAlphabet } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ForbiddenVideoAccessException,
  InvalidRangeException,
  UploadNotCompletableException,
  UploadTooLargeException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService, type UploadPartRef } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  mapVideoToView,
  PaginatedVideosDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';

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

export interface UploadStatusView {
  publicId: string;
  status: VideoStatus;
}

export interface StreamResult {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
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

  /**
   * Finalize the multipart upload from the client-provided part ETags, move the video to
   * `processing`, clear the upload id, and enqueue the background processing job. Owner-only.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: UploadPartRef[],
  ): Promise<UploadStatusView> {
    const video = await this.loadOwnedVideo(userId, publicId);

    const uploadId = video.upload_id;
    if (video.status !== VideoStatus.UPLOADING || !uploadId) {
      throw new UploadNotCompletableException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      uploadId,
      parts,
    );
    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    await this.videoQueueService.enqueueProcessing(video.id);

    return { publicId: video.public_id, status: VideoStatus.PROCESSING };
  }

  /** Cancel an in-progress upload: abort the multipart upload and remove the draft. Owner-only. */
  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.loadOwnedVideo(userId, publicId);

    const uploadId = video.upload_id;
    if (
      (video.status !== VideoStatus.DRAFT &&
        video.status !== VideoStatus.UPLOADING) ||
      !uploadId
    ) {
      throw new UploadNotCompletableException();
    }

    await this.storageService.abortMultipartUpload(video.storage_key, uploadId);
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Public view of a single video. `ready` videos are visible to anyone; drafts/processing/error
   * videos are only visible to their owner (hidden from strangers as a 404). Owners also see the
   * raw metadata and any failure reason.
   */
  async getByPublicId(
    publicId: string,
    userId: string | null,
  ): Promise<VideoResponseDto> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const owner = userId !== null && (await this.isOwner(video, userId));
    if (video.status !== VideoStatus.READY && !owner) {
      throw new VideoNotFoundException();
    }

    return mapVideoToView(video, { includeOwnerFields: owner });
  }

  /** List the caller's own channel videos (any status), newest first, paginated. */
  async listOwn(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedVideosDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      return { items: [], total: 0, page, pageSize };
    }

    const [videos, total] = await this.videoRepository.findAndCount({
      where: { channel_id: channel.id },
      relations: ['channel'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: videos.map((v) => mapVideoToView(v, { includeOwnerFields: true })),
      total,
      page,
      pageSize,
    };
  }

  private async isOwner(video: Video, userId: string): Promise<boolean> {
    const channel = await this.channelsService.findByUserId(userId);
    return channel !== null && channel.id === video.channel_id;
  }

  /**
   * Build the response for GET /stream (ready videos only). With a valid Range header it returns a
   * 206 partial stream (Content-Range/Accept-Ranges); without one, a 200 full stream with
   * Accept-Ranges. An unsatisfiable range raises 416.
   */
  async getStreamData(
    publicId: string,
    rangeHeader: string | undefined,
  ): Promise<StreamResult> {
    const video = await this.loadReadyVideo(publicId);
    const head = await this.storageService.headObject(video.storage_key);
    const total = head.contentLength;

    if (!rangeHeader) {
      const full = await this.storageService.getObjectRange(video.storage_key);
      return {
        status: 200,
        headers: {
          'Content-Type': head.contentType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        },
        stream: full.stream,
      };
    }

    const { start, end } = this.parseRange(rangeHeader, total);
    const partial = await this.storageService.getObjectRange(
      video.storage_key,
      `bytes=${start}-${end}`,
    );
    return {
      status: 206,
      headers: {
        'Content-Type': head.contentType,
        'Content-Length': String(partial.contentLength),
        'Content-Range':
          partial.contentRange ?? `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
      },
      stream: partial.stream,
    };
  }

  /** Build the response for GET /download — the full object as an attachment (ready videos only). */
  async getDownloadData(publicId: string): Promise<StreamResult> {
    const video = await this.loadReadyVideo(publicId);
    const object = await this.storageService.getObjectRange(video.storage_key);
    return {
      status: 200,
      headers: {
        'Content-Type': object.contentType,
        'Content-Length': String(object.contentLength),
        'Content-Disposition': `attachment; filename="${video.original_filename}"`,
      },
      stream: object.stream,
    };
  }

  /** Build the response for GET /thumbnail. 404 until the worker has generated one. */
  async getThumbnailData(publicId: string): Promise<StreamResult> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video || !video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    const object = await this.storageService.getObjectRange(
      video.thumbnail_key,
    );
    return {
      status: 200,
      headers: {
        'Content-Type': object.contentType || 'image/jpeg',
        'Content-Length': String(object.contentLength),
      },
      stream: object.stream,
    };
  }

  private async loadReadyVideo(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private parseRange(
    rangeHeader: string,
    total: number,
  ): { start: number; end: number } {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      throw new InvalidRangeException();
    }
    const [, startStr, endStr] = match;

    let start: number;
    let end: number;
    if (startStr === '') {
      // Suffix range: bytes=-N → the last N bytes.
      const suffix = Number(endStr);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        throw new InvalidRangeException();
      }
      start = Math.max(total - suffix, 0);
      end = total - 1;
    } else {
      start = Number(startStr);
      end = endStr === '' ? total - 1 : Number(endStr);
    }

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      start >= total
    ) {
      throw new InvalidRangeException();
    }

    return { start, end: Math.min(end, total - 1) };
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
