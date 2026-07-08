import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short, non-enumerable public URL identifier (nanoid, generated in the service — TD-06). */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  /** `videos/{id}/original/{filename}` in the bucket (TD-03). */
  @Column({ type: 'varchar' })
  storage_key: string;

  /** `videos/{id}/thumbnail.jpg`, set by the worker once processing succeeds (TD-04). */
  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  /** S3 multipart UploadId while uploading; cleared on complete/abort (TD-02). */
  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  /**
   * Declared on draft, confirmed after processing. Stored as bigint (10GB > int range);
   * the transformer surfaces it as a JS number, safe for sizes below 2^53.
   */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  size_bytes: number | null;

  /** Extracted by ffprobe (TD-04). */
  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  /** `{ width, height, codec, bitrate, ... }` from ffprobe. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  /** Set when status = 'error' (TD-08). */
  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
