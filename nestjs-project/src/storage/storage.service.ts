import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';

/** A part of a completed multipart upload, as reported back by the client. */
export interface UploadPartRef {
  partNumber: number;
  eTag: string;
}

/** Result of a ranged (or full) object read, ready to be piped to an HTTP response. */
export interface ObjectRange {
  stream: Readable;
  contentLength: number;
  contentType: string;
  /** Present only when the request carried a `Range` (S3 answers with `Content-Range`). */
  contentRange?: string;
}

/** Metadata returned by a HEAD request — total size and content type, no body. */
export interface ObjectHead {
  contentLength: number;
  contentType: string;
}

/**
 * Thin wrapper over the S3 API (MinIO in dev, S3-compatible in prod) exposing exactly
 * the operations Phase 03 needs: presigned multipart upload, ranged reads for streaming,
 * thumbnail puts and prefix deletes. Path-style addressing is mandatory for MinIO (TD-03).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignExpirationSeconds: number;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.presignExpirationSeconds = config.presignExpirationSeconds;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Idempotently ensure the bucket exists: HEAD it, create it only on a 404. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log(`Created storage bucket "${this.bucket}"`);
      } catch (createErr) {
        // A concurrent init may have created it first — that is success, not failure.
        if (!this.isAlreadyOwned(createErr)) throw createErr;
      }
    }
  }

  /** Initiate an S3 multipart upload; returns the UploadId the client uses for its parts. */
  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }
    return { uploadId: res.UploadId };
  }

  /** Presigned PUT URL for a single part — the client uploads bytes straight to storage. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.presignExpirationSeconds },
    );
  }

  /** Finalize a multipart upload from the client-reported part numbers + ETags. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPartRef[],
  ): Promise<void> {
    const orderedParts = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: orderedParts },
      }),
    );
  }

  /** Abort a multipart upload, discarding any uploaded parts. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** HEAD an object for its total size and content type without transferring the body. */
  async headObject(key: string): Promise<ObjectHead> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  }

  /**
   * Read an object, optionally a byte range (`bytes=start-end`). S3 honors the Range and
   * returns only the requested window with a `Content-Range` header, so the caller never
   * buffers the whole file.
   */
  async getObjectRange(key: string, range?: string): Promise<ObjectRange> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );
    return {
      stream: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
      contentRange: res.ContentRange,
    };
  }

  /** Put a small object (e.g. a generated thumbnail) directly. */
  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Presigned GET URL — used by the worker to let ffprobe read the source over HTTP. */
  async presignGetObject(
    key: string,
    expiresIn: number = this.presignExpirationSeconds,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  /** Delete every object under a prefix (e.g. `videos/{id}/` — original + thumbnail). */
  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string');

      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }

      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  private isNotFound(err: unknown): boolean {
    const e = err as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return (
      e?.name === 'NotFound' ||
      e?.name === 'NoSuchBucket' ||
      e?.$metadata?.httpStatusCode === 404
    );
  }

  private isAlreadyOwned(err: unknown): boolean {
    const e = err as { name?: string };
    return (
      e?.name === 'BucketAlreadyOwnedByYou' || e?.name === 'BucketAlreadyExists'
    );
  }
}
