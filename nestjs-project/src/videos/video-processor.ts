import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoMetadataService } from './video-metadata.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

/**
 * Consumes the `video-processing` queue. For each job it (idempotently) probes the uploaded
 * video for duration/metadata, generates a thumbnail, uploads it, and marks the video `ready`.
 * On terminal failure (retries exhausted) it marks the video `error` with the reason.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly metadataService: VideoMetadataService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      // The row was removed (e.g. aborted) after the job was enqueued — nothing to do.
      this.logger.warn(`Video ${videoId} not found; skipping job ${job.id}`);
      return;
    }
    if (video.status === VideoStatus.READY) {
      // At-least-once delivery: re-processing a finished video is a no-op.
      return;
    }

    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING },
    );

    // Read metadata over a presigned URL (no full download), then extract the thumbnail.
    const sourceUrl = await this.storageService.presignGetObject(
      video.storage_key,
    );
    const metadata = await this.metadataService.probe(sourceUrl);
    const thumbnail = await this.metadataService.generateThumbnail(sourceUrl);

    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    const metadataJson: Record<string, number | string> = {};
    if (metadata.width !== null) metadataJson.width = metadata.width;
    if (metadata.height !== null) metadataJson.height = metadata.height;
    if (metadata.codec !== null) metadataJson.codec = metadata.codec;
    if (metadata.bitrate !== null) metadataJson.bitrate = metadata.bitrate;

    await this.videoRepository.save({
      id: video.id,
      status: VideoStatus.READY,
      duration_seconds: metadata.durationSeconds,
      thumbnail_key: thumbnailKey,
      size_bytes: metadata.sizeBytes ?? video.size_bytes,
      metadata: metadataJson,
    });
    this.logger.log(`Video ${video.id} processed → ready`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Retries remain — let BullMQ back off and try again.
      return;
    }
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.ERROR, failure_reason: err.message },
    );
    this.logger.error(
      `Video ${job.data.videoId} failed permanently: ${err.message}`,
    );
  }
}
