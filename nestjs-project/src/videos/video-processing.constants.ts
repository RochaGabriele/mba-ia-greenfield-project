export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;
export const PROCESS_VIDEO_JOB = 'process' as const;

/**
 * Payload of the video-processing job. Only the internal video id travels on the queue —
 * the worker re-reads the row so it always processes the current state (avoids stale data).
 */
export interface ProcessVideoJobData {
  videoId: string;
}
