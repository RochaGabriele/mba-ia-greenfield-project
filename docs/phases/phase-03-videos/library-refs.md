---
libs:
  bullmq:
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-07T18:40:00-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-07T18:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-07T18:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-07T18:40:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-07T18:40:00-03:00"
  nanoid:
    version: "^5.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-07T18:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-07T18:20:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries fixed by the Phase 03 decisions. **Context7 note:** the project's
context7 MCP server was not connected during this planning session, so the API notes below are
distilled from each library's official documentation. Per `CLAUDE.md` ("Library Documentation
Lookup"), each API MUST be re-cross-checked via context7 against the **installed** version at the
start of the SI that uses it; flag any discrepancy before implementing. `context7_id` values above
are the canonical library ids to resolve.

## bullmq + @nestjs/bullmq (TD-01, TD-05)

The NestJS wrapper exposes BullMQ's producer/consumer through DI.

### Registration (producer side — API)

```typescript
// app/queue module
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort }, // host = Compose service name 'redis'
  }),
});
BullModule.registerQueue({ name: 'video-processing' });
```

### Producing a job (API, after upload completes)

```typescript
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

await this.queue.add(
  'process',
  { videoId },                       // payload — keep it minimal (id only), worker re-reads DB
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false,             // keep failed jobs for inspection
  },
);
```

### Consuming a job (worker)

```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // idempotent — BullMQ is at-least-once
    // 1. set status 'processing'; 2. ffprobe metadata; 3. thumbnail; 4. set 'ready'
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // fires after each attempt; when job.attemptsMade === job.opts.attempts → set status 'error' + reason
  }
}
```

**Key contracts for Phase 03:**
- `connection.host` must be the Compose service name (`redis`), never `localhost` (CLAUDE.md Docker rule).
- The processor MUST be **idempotent** (at-least-once delivery) — re-running `process` on a `ready` video is a no-op.
- Job payload carries only `videoId`; the worker re-reads the row (single source of truth) — avoids stale-data jobs.
- The worker runs in a **separate Nest standalone context** (`NestFactory.createApplicationContext(WorkerModule)`), not the HTTP app.
- Redis persistence (AOF) should be enabled in the Compose service so queued jobs survive restarts.

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner (TD-02, TD-03, TD-07)

Official S3 SDK v3, pointed at MinIO with path-style addressing.

### Client

```typescript
const s3 = new S3Client({
  endpoint: cfg.endpoint,          // http://minio:9000 (Compose service name)
  region: cfg.region,              // 'us-east-1' (MinIO ignores but SDK requires)
  forcePathStyle: true,            // REQUIRED for MinIO
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

### Presigned Multipart Upload (10GB, TD-02)

```typescript
// 1. initiate
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
// 2. presign each part (client PUTs directly to MinIO)
const url = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);
// 3. complete (client sends back { PartNumber, ETag }[])
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId, MultipartUpload: { Parts },
}));
// abort on cancel
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

### Ranged read for streaming (TD-07)

```typescript
const res = await s3.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1048575' }));
// res.Body is a Readable (Node stream) → pipe to the HTTP response with 206
// res.ContentRange, res.ContentLength, res.ContentType carry the range metadata
// HeadObjectCommand gives total size + content-type without a body (for Content-Range total)
```

**Key contracts:**
- `forcePathStyle: true` and `endpoint` set to the Compose service name are mandatory for MinIO.
- A single presigned PUT is capped at 5GB → multipart is required for 10GB (TD-02).
- `GetObjectCommand` honors the `Range` header → the API forwards only the requested window (never the whole file).
- Bucket must be ensured on startup (`HeadBucketCommand` → `CreateBucketCommand` if 404) — idempotent.

## fluent-ffmpeg (TD-04)

Node wrapper over the system `ffmpeg`/`ffprobe` binaries (installed in the worker image).

### Metadata (duration + streams) via ffprobe

```typescript
const data = await new Promise<FfprobeData>((resolve, reject) =>
  ffmpeg.ffprobe(inputUrl, (err, d) => (err ? reject(err) : resolve(d))),
);
const durationSec = data.format.duration;                 // seconds (float)
const videoStream = data.streams.find((s) => s.codec_type === 'video');
// videoStream.width, .height, .codec_name; data.format.size, .bit_rate
```

### Thumbnail (single frame)

```typescript
await new Promise<void>((resolve, reject) =>
  ffmpeg(inputUrl)
    .screenshots({
      timestamps: ['10%'],          // a frame ~10% into the video
      filename: 'thumbnail.jpg',
      folder: tmpDir,
      size: '1280x720',
    })
    .on('end', () => resolve())
    .on('error', reject),
);
// then upload tmpDir/thumbnail.jpg to videos/{videoId}/thumbnail.jpg
```

**Key contracts:**
- `ffmpeg`/`ffprobe` must exist on `PATH` in the worker image (apt `ffmpeg`); optionally set paths via `ffmpeg.setFfmpegPath`/`setFfprobePath`.
- `ffprobe(inputUrl)` reads metadata from a presigned GET URL **without downloading the full 10GB** — only the moov/header is fetched.
- `fluent-ffmpeg` is in maintenance mode → pin the version; use only `.ffprobe()` and `.screenshots()` (stable surface).
- The callback APIs are wrapped in Promises for `async` service methods.

## nanoid (TD-06)

```typescript
import { customAlphabet } from 'nanoid';
// URL-safe, unambiguous alphabet; 11 chars ≈ 10^19 space
const generatePublicId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 11);
const publicId = generatePublicId();
```

**Key contracts:**
- v5 is **ESM-only** — confirm the project's module setup handles it (NestJS/TS `moduleResolution: node16/nodenext` or dynamic import) at the SI that uses it; if the CJS build config rejects ESM-only, pin `nanoid@^3.x` (CJS) as the documented fallback. **Re-verify via context7 against the installed version.**
- `public_id` column has a **unique** constraint; on the (astronomically rare) collision, regenerate and retry.
