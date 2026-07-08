import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideoQueueService;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoQueueService],
    }).compile();

    service = moduleRef.get(VideoQueueService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    // Pause so that a running video-worker (once SI-03.8 lands) cannot consume the job
    // before this producer test asserts on it — keeps the assertion deterministic.
    await queue.pause();
  });

  it('enqueues a process job carrying the videoId with the configured retry policy', async () => {
    const videoId = 'video-abc';

    await service.enqueueProcessing(videoId);

    const jobs = await queue.getJobs([
      'waiting',
      'paused',
      'delayed',
      'prioritized',
    ]);
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    expect(job.name).toBe(PROCESS_VIDEO_JOB);
    expect(job.data).toEqual({ videoId });
    expect(job.opts.attempts).toBe(queueConfig().videoProcessingAttempts);
    expect(job.opts.backoff).toEqual({
      type: 'exponential',
      delay: queueConfig().videoProcessingBackoffMs,
    });
  });
});
