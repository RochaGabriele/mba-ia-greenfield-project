import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  // Redis connection for BullMQ (Compose service name, per CLAUDE.md Docker rule).
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Video-processing job retry policy (TD-08).
  videoProcessingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  videoProcessingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
}));
