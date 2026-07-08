import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-processing.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('compiles and registers the video-processing queue', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();

    await moduleRef.close();
  });
});
