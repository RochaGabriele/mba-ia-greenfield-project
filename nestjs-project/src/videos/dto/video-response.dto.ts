import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

export class ChannelSummaryDto {
  @ApiProperty()
  nickname: string;
}

export class VideoResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true })
  durationSeconds: number | null;

  @ApiProperty({ type: String, nullable: true })
  thumbnailUrl: string | null;

  @ApiProperty({ type: ChannelSummaryDto })
  channel: ChannelSummaryDto;

  @ApiProperty()
  createdAt: Date;

  /** Owner-only: raw ffprobe metadata. */
  @ApiProperty({ required: false, nullable: true, type: Object })
  metadata?: Record<string, unknown> | null;

  /** Owner-only: reason when status is `error`. */
  @ApiProperty({ required: false, nullable: true, type: String })
  failureReason?: string | null;
}

export class PaginatedVideosDto {
  @ApiProperty({ type: [VideoResponseDto] })
  items: VideoResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}

/** Map a Video entity (with its channel relation loaded) to the public view. */
export function mapVideoToView(
  video: Video,
  opts: { includeOwnerFields: boolean },
): VideoResponseDto {
  const view: VideoResponseDto = {
    publicId: video.public_id,
    title: video.title,
    status: video.status,
    durationSeconds: video.duration_seconds,
    thumbnailUrl: video.thumbnail_key
      ? `/videos/${video.public_id}/thumbnail`
      : null,
    channel: { nickname: video.channel?.nickname ?? '' },
    createdAt: video.created_at,
  };

  if (opts.includeOwnerFields) {
    view.metadata = video.metadata;
    view.failureReason = video.failure_reason;
  }

  return view;
}
