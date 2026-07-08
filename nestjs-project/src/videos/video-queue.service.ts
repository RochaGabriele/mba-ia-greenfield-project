import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { ProcessVideoJobData } from './video-processing.constants';

/** Producer: enqueues the background processing job after an upload completes. */
@Injectable()
export class VideoQueueService {
  private readonly logger = new Logger(VideoQueueService.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    // A BullMQ queue's connection 'error' event throws if unhandled (e.g. a transient Redis
    // issue). Log it instead of crashing the process.
    this.queue.on('error', (err) => this.logger.error(err.message));
  }

  /**
   * Enqueue the `process` job for a video. Retries with exponential backoff (TD-08);
   * failed jobs are retained for inspection; the consumer is idempotent (at-least-once).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        attempts: this.config.videoProcessingAttempts,
        backoff: {
          type: 'exponential',
          delay: this.config.videoProcessingBackoffMs,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
