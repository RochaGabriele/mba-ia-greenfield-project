import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';

/**
 * Video domain module. Owns the Video entity and the queue producer; imports the channel
 * domain (ownership), object storage, and the processing queue. The service and controller
 * are added in later SIs (create-draft, upload, streaming).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  providers: [VideoQueueService],
  exports: [TypeOrmModule],
})
export class VideosModule {}
