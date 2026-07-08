import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Video domain module. Owns the Video entity, the HTTP controller, and the queue producer;
 * imports the channel domain (ownership), object storage, the processing queue, and auth
 * (for the OptionalJwtAuthGuard used by the public single-get endpoint).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    AuthModule,
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoQueueService],
  exports: [TypeOrmModule],
})
export class VideosModule {}
