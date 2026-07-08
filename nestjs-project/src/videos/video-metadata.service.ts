import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  sizeBytes: number | null;
}

/**
 * Wraps the system `ffprobe`/`ffmpeg` binaries (via fluent-ffmpeg) for the two operations the
 * worker needs: metadata extraction and a single-frame thumbnail. Input is any ffmpeg-readable
 * source — a presigned GET URL is used so metadata is read without downloading the whole file.
 */
@Injectable()
export class VideoMetadataService {
  /** Extract duration and stream metadata with ffprobe. */
  async probe(input: string): Promise<VideoMetadata> {
    const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(input, (err, probed) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(probed),
      );
    });

    const videoStream = data.streams.find((s) => s.codec_type === 'video');
    const duration = Number(data.format.duration ?? 0);

    return {
      durationSeconds: Number.isFinite(duration) ? Math.round(duration) : 0,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      bitrate: data.format.bit_rate ? Number(data.format.bit_rate) : null,
      sizeBytes: data.format.size ? Number(data.format.size) : null,
    };
  }

  /** Capture a single frame at ~10% of the video and return it as a JPEG buffer. */
  async generateThumbnail(input: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'streamtube-thumb-'));
    const filename = 'thumbnail.jpg';
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(input)
          .screenshots({
            timestamps: ['10%'],
            filename,
            folder: dir,
            size: '1280x720',
          })
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });
      return await readFile(join(dir, filename));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
