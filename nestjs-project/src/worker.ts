import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entry point for the video worker. Boots a standalone Nest application context (no HTTP server);
 * the BullMQ `@Processor` registered in WorkerModule starts consuming the queue automatically.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log(
    'Video worker started — consuming the video-processing queue',
  );
}

void bootstrap();
