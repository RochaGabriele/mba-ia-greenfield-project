---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-07T18:20:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-07T18:30:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-07T18:40:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file (up to 10GB) video upload without routing bytes through the API, automatic
background processing (duration/metadata extraction + thumbnail generation) via a queue and a
dedicated FFmpeg worker, unique public video URLs, HTTP-range streaming, and download — establishing
the storage + queue + worker infrastructure and the `Video` domain that Fases 04–05 build upon.

All new infrastructure (MinIO object storage, Redis queue, video-worker) runs in Docker Compose and
is exercised by real integration/e2e tests. Definition of Done (CLAUDE.md) applies: full suite green
+ `npx tsc --noEmit` (code 0) + `npm run lint`.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infrastructure

**Description:** Install Phase 03 dependencies, add `storage` and `queue` config namespaces (`registerAs` pattern from Phase 01), extend the Joi schema and `.env.example`, and add the MinIO, Redis, and `video-worker` services to Docker Compose, plus a worker Dockerfile that installs FFmpeg.

**Technical actions:**

- Install production deps in `nestjs-project`: `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.1.x`, `nanoid@^5.x`; dev deps: `@types/fluent-ffmpeg@^2.1.x`. (Re-verify each version + API via context7 against the installed manifest per CLAUDE.md before use.)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (default `'http://minio:9000'`), `STORAGE_REGION` (default `'us-east-1'`), `STORAGE_ACCESS_KEY` (required), `STORAGE_SECRET_KEY` (required), `STORAGE_BUCKET` (default `'streamtube-videos'`), `STORAGE_PUBLIC_ENDPOINT` (default `'http://localhost:9000'`, used only if presigned URLs are ever returned to browsers), `UPLOAD_PART_SIZE_MB` (default `100`), `MAX_UPLOAD_SIZE_GB` (default `10`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_PROCESSING_BACKOFF_MS` (default `5000`).
- Update `src/config/env.validation.ts` — add all new variables to the Joi schema (`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` required; others with defaults). Update `.env.example` with Compose-compatible defaults (hosts = service names: `minio`, `redis`).
- Add to `nestjs-project/compose.yaml`: **`minio`** (`minio/minio`, `server /data --console-address ":9001"`, ports 9000/9001, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, healthcheck on `/minio/health/live`, `minio-data` volume); **`redis`** (`redis:7`, port 6379, `--appendonly yes`, `redis-data` volume, healthcheck `redis-cli ping`); **`video-worker`** (build with `Dockerfile.worker`, command runs the worker entrypoint, `depends_on` db+redis+minio healthy, same env as the API). Add `nestjs-api` `depends_on` redis + minio (healthy).
- Create `nestjs-project/Dockerfile.worker` — same Node base as `Dockerfile.dev` plus `apt-get install -y ffmpeg`; entrypoint runs `node dist/worker` (or `npm run start:worker:dev` in dev). Add `start:worker`/`start:worker:dev` scripts to `package.json`.

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `nestjs-api`, `db`, `mailpit`, `minio`, `redis`, `video-worker` — all become healthy.
- The API starts without errors when all new env vars are provided; the existing E2E test (`GET /` → 200) still passes.
- Starting without `STORAGE_ACCESS_KEY` or `STORAGE_SECRET_KEY` causes a Joi validation error at bootstrap — the app does not start.
- MinIO console is reachable at `localhost:9001`; Redis answers `PING` inside the Compose network; `ffmpeg -version` runs inside the `video-worker` container.

---

### SI-03.2 — Storage Module (S3/MinIO Service)

**Description:** Create a `StorageModule` exposing a `StorageService` that wraps `@aws-sdk/client-s3` (path-style, MinIO endpoint) with the operations the phase needs: ensure bucket, initiate/presign/complete/abort multipart upload, ranged read, head, put (thumbnail), and delete-by-prefix.

**Technical actions:**

- Create `src/storage/storage.service.ts` — `StorageService` injecting `storageConfig`. Construct one `S3Client` (`endpoint`, `region`, `forcePathStyle: true`, credentials). On `onModuleInit`, `ensureBucket()` (`HeadBucketCommand` → `CreateBucketCommand` on 404). Methods: `createMultipartUpload(key): Promise<{ uploadId }>`; `presignUploadPart(key, uploadId, partNumber): Promise<string>` (via `getSignedUrl` + `UploadPartCommand`, `expiresIn` from config); `completeMultipartUpload(key, uploadId, parts): Promise<void>`; `abortMultipartUpload(key, uploadId): Promise<void>`; `headObject(key): Promise<{ contentLength, contentType }>`; `getObjectRange(key, range?): Promise<{ stream, contentLength, contentRange?, contentType }>`; `putObject(key, body, contentType): Promise<void>`; `presignGetObject(key, expiresIn): Promise<string>`; `deletePrefix(prefix): Promise<void>`.
- Create `src/storage/storage.module.ts` — provides and exports `StorageService`; imports `ConfigModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: ensureBucket is idempotent; multipart initiate→presign→PUT part→complete round-trips a small object; getObjectRange returns the requested byte window with correct `Content-Range`; putObject + headObject; deletePrefix removes all keys under a prefix |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles and exports StorageService |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Uploading an object via presigned multipart (initiate → presigned PUT of one part → complete) stores it in MinIO and it is retrievable.
- `getObjectRange(key, 'bytes=0-9')` returns exactly 10 bytes with `Content-Range: bytes 0-9/<total>`.
- `ensureBucket()` succeeds whether or not the bucket already exists.
- `deletePrefix('videos/<id>/')` removes both the original and the thumbnail objects.

---

### SI-03.3 — Queue Module (BullMQ Producer)

**Description:** Wire BullMQ into the API as a producer: register the `video-processing` queue via `@nestjs/bullmq`, and a small typed producer that enqueues the `process` job with the phase's retry/backoff policy.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` (inject `queueConfig`, `connection: { host: redisHost, port: redisPort }`), `BullModule.registerQueue({ name: 'video-processing' })`; export `BullModule`.
- Create `src/videos/video-processing.constants.ts` — export `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process'`, and the `ProcessVideoJobData` type `{ videoId: string }`.
- Create `src/videos/video-queue.service.ts` — `VideoQueueService` injecting `@InjectQueue(VIDEO_PROCESSING_QUEUE)`. Method `enqueueProcessing(videoId: string)` adds `PROCESS_VIDEO_JOB` with `{ attempts, backoff: { type: 'exponential', delay }, removeOnComplete: true, removeOnFail: false }` from `queueConfig`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-queue.service.integration-spec.ts` | Integration | Against real Redis: `enqueueProcessing(id)` adds a job to the `video-processing` queue with the configured attempts/backoff; the job payload is `{ videoId: id }` |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with BullModule wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Calling `enqueueProcessing(videoId)` results in exactly one waiting job on the `video-processing` queue in Redis with `name = 'process'` and data `{ videoId }`.
- The job's options carry `attempts = VIDEO_PROCESSING_ATTEMPTS` and exponential backoff.

---

### SI-03.4 — Video Entity and Migration

**Description:** Create the `Video` entity linked to `Channel`, with the status lifecycle, storage keys, unique public id, and processing metadata. Generate and review the migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` (see Data Model below). Status via a PostgreSQL enum column. `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`; add index on `channel_id`, unique index on `public_id`. `public_id` generated in the service (nanoid), not in the DB.
- Update `src/channels/entities/channel.entity.ts` — add inverse `@OneToMany(() => Video, (video) => video.channel)` relation (`videos`). No new column.
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos`; review the SQL (enum type creation, FK to `channels`, unique `public_id`, indexes).
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, imports `ChannelsModule`, `StorageModule`, `QueueModule`; provides `VideosService`, `VideoQueueService`; controllers added in later SIs; exports `TypeOrmModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | `status` defaults to `'draft'`; `public_id` unique constraint; `channel_id` FK to channels; nullable columns (`storage_key`, `thumbnail_key`, `duration_seconds`, `metadata`, `upload_id`, `failure_reason`) accept null; timestamps auto-populated |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule.forFeature + ChannelsModule + StorageModule + QueueModule wiring |

**Dependencies:** SI-03.1, SI-03.2, SI-03.3

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the status enum type, the FK to `channels`, a unique index on `public_id`, and an index on `channel_id`.
- A newly created video has `status = 'draft'`.
- Inserting two videos with the same `public_id` fails with a unique-constraint violation.
- A video with a non-existent `channel_id` fails the FK constraint.

---

### SI-03.5 — Create Draft + Initiate Multipart Upload

**Description:** Implement `POST /videos` — authenticated, scoped to the caller's channel. It pre-registers the video as a `draft`, generates the unique `public_id`, computes the storage key, and initiates the multipart upload, returning the data the client needs to upload parts directly to MinIO.

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` with `@IsString() @MinLength(1) @MaxLength(200)` title, `@IsString() @IsNotEmpty()` filename, `@IsInt() @Min(1) @Max(MAX_UPLOAD_SIZE_BYTES)` sizeBytes, `@IsString() @IsOptional()` contentType.
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `ChannelsService` (resolve caller's channel), `StorageService`. Implement `createDraft(userId, dto)`: (1) reject `sizeBytes > MAX_UPLOAD_SIZE_GB` → `PayloadTooLargeException`; (2) resolve the caller's channel; (3) generate `public_id` via nanoid (retry on unique violation); (4) build `storage_key = videos/{video.id}/original/{sanitizedFilename}`; (5) `createMultipartUpload(storage_key)` → `uploadId`; (6) persist the video row `{ status: 'draft', title, channel_id, public_id, storage_key, original_filename, size_bytes, upload_id }`; (7) return `{ publicId, uploadId, storageKey, partSize, status }`.
- Create `src/videos/videos.controller.ts` — `@Controller('videos')`, `@Post()` (auth required) calling `createDraft(currentUser.sub, dto)`, returns 201.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | createDraft: generates public_id, computes key, calls createMultipartUpload, persists draft; rejects oversized; retries public_id on collision |
| `src/videos/videos.service.integration-spec.ts` | Integration | createDraft persists a draft video with a real multipart upload initiated in MinIO; public_id is unique |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 with `{ publicId, uploadId, storageKey, partSize }` for an authenticated user; 401 without token; 400 on invalid body; 413 when sizeBytes exceeds the limit |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos` (authenticated) with a valid body returns 201 with `{ publicId, uploadId, storageKey, partSize, status: 'draft' }` and persists a `draft` video owned by the caller's channel.
- The video's `public_id` is an 11-char URL-safe string, unique across all videos.
- `POST /videos` without a valid access token returns 401.
- `POST /videos` with `sizeBytes` above the 10GB limit returns 413 `UPLOAD_TOO_LARGE`.

---

### SI-03.6 — Presign Upload Part URLs

**Description:** Implement `POST /videos/{publicId}/upload/part-urls` — returns presigned PUT URLs for the requested part numbers so the client uploads each part directly to MinIO. Only the owner, only while the video is `draft`/`uploading`.

**Technical actions:**

- Create `src/videos/dto/presign-parts.dto.ts` — `PresignPartsDto` with `@IsArray() @ArrayNotEmpty() @IsInt({ each: true }) @Min(1, { each: true })` partNumbers.
- Implement `presignParts(userId, publicId, partNumbers)` in `VideosService` — load video by `public_id`; `VideoNotFoundException` if missing; ownership check (`ForbiddenVideoAccessException` if the channel is not the caller's); state check (must be `draft` or `uploading`, else `UploadNotCompletableException`); if `draft`, transition to `uploading`; for each part number, `storageService.presignUploadPart(storage_key, upload_id, partNumber)`; return `[{ partNumber, url }]`.
- Add `@Post(':publicId/upload/part-urls')` to `VideosController` (auth required).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | presignParts: ownership + state checks; transitions draft→uploading; returns one URL per requested part |
| `src/videos/videos.service.integration-spec.ts` | Integration | Returned presigned URLs successfully PUT parts to MinIO for the video's multipart upload |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:publicId/upload/part-urls` 201 with URLs for the owner; 403 for a non-owner; 404 for unknown publicId; 409 when the video is already `ready` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/{publicId}/upload/part-urls` with `{ partNumbers: [1,2] }` (owner) returns 201 with two `{ partNumber, url }` entries; each URL PUTs its part directly to MinIO.
- Requesting part URLs for a video owned by another channel returns 403 `FORBIDDEN_VIDEO_ACCESS`.
- Requesting part URLs for an unknown `publicId` returns 404 `VIDEO_NOT_FOUND`.
- The first successful call transitions the video from `draft` to `uploading`.

---

### SI-03.7 — Complete Upload and Enqueue Processing

**Description:** Implement `POST /videos/{publicId}/upload/complete` — finalizes the multipart upload with the client-provided part ETags, transitions the video to `processing`, and enqueues the processing job. Also `POST /videos/{publicId}/upload/abort` to cancel.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `@IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => UploadPartDto)` parts, where `UploadPartDto` has `@IsInt() @Min(1)` partNumber and `@IsString() @IsNotEmpty()` eTag.
- Implement `completeUpload(userId, publicId, parts)` in `VideosService` — load + ownership + state (`uploading`) checks; `storageService.completeMultipartUpload(storage_key, upload_id, parts)`; set `status = 'processing'`, clear `upload_id`; `videoQueueService.enqueueProcessing(video.id)`; return the video view. Implement `abortUpload(userId, publicId)` — ownership + state (`draft`/`uploading`) checks; `storageService.abortMultipartUpload(...)`; delete the draft row (or mark `error`). 
- Add `@Post(':publicId/upload/complete')` and `@Post(':publicId/upload/abort')` to `VideosController` (auth required).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | completeUpload: completes multipart, sets processing, enqueues job; abortUpload aborts + removes draft; state/ownership guards |
| `src/videos/videos.service.integration-spec.ts` | Integration | completeUpload finalizes the MinIO object and enqueues a real job on Redis; status persisted as `processing` |
| `test/videos.e2e-spec.ts` | E2E | Full upload: create → part-urls → PUT parts → complete → 200 with status `processing`; a job is present on the queue; abort returns 204 and removes the draft |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `POST /videos/{publicId}/upload/complete` with valid part ETags (owner) finalizes the object in MinIO, sets the video to `processing`, and enqueues exactly one `process` job carrying the video id.
- After completion, `GET` of the storage key returns the fully assembled object.
- `POST /videos/{publicId}/upload/abort` (owner, before completion) aborts the multipart upload and removes the draft; returns 204.
- Completing/aborting a video owned by another channel returns 403.

---

### SI-03.8 — Video Worker: Processing, Metadata, and Thumbnail

**Description:** Implement the standalone `video-worker`: a NestJS application context hosting the BullMQ `@Processor` for `video-processing`. On each job it sets `processing`, extracts duration + metadata with ffprobe, generates a thumbnail with FFmpeg, uploads it to storage, and sets `ready`. On terminal failure it sets `error` with a reason.

**Technical actions:**

- Create `src/videos/video-processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` `VideoProcessor extends WorkerHost`, injecting `Repository<Video>` and `StorageService` (and a `VideoMetadataService` wrapping fluent-ffmpeg). `process(job)`: idempotent — if the video is already `ready`, return; set `status = 'processing'`; obtain a presigned GET URL for `storage_key`; `ffprobe` → `{ durationSeconds, width, height, codec, sizeBytes, bitrate }`; generate a thumbnail frame at ~10% via `.screenshots()` into a temp dir; `putObject(thumbnail_key, buffer, 'image/jpeg')` where `thumbnail_key = videos/{id}/thumbnail.jpg`; persist `duration_seconds`, `metadata` (jsonb), `thumbnail_key`, `size_bytes`, `status = 'ready'`. `@OnWorkerEvent('failed')`: when `attemptsMade >= attempts`, set `status = 'error'`, `failure_reason = err.message`.
- Create `src/videos/video-metadata.service.ts` — wraps `ffmpeg.ffprobe` and `.screenshots` in Promises (see `library-refs.md`).
- Create `src/worker.module.ts` — `WorkerModule` importing config, `TypeOrmModule.forRootAsync` (same as API) + `forFeature([Video])`, `StorageModule`, `BullModule.forRootAsync`, and providing `VideoProcessor` + `VideoMetadataService`.
- Create `src/worker.ts` — bootstrap `NestFactory.createApplicationContext(WorkerModule)`; BullMQ starts consuming automatically via the registered processor. Add `start:worker`/`start:worker:dev` scripts.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-metadata.service.integration-spec.ts` | Integration | Against a real small sample video in MinIO: ffprobe returns a plausible duration and resolution; thumbnail is generated as a valid JPEG |
| `src/videos/video-processor.integration-spec.ts` | Integration | Against real Redis + MinIO + Postgres + FFmpeg: enqueuing a job for an uploaded video drives it to `ready` with duration, metadata, and a thumbnail object present; a job for a corrupt/absent object drives it to `error` with a `failure_reason` after retries; re-processing a `ready` video is a no-op |
| `src/worker.module.spec.ts` | Unit | WorkerModule compiles with the processor wiring |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- Enqueuing a `process` job for a completed upload drives the video to `ready`, persisting `duration_seconds`, `metadata`, and a `thumbnail_key`; the thumbnail object exists in MinIO at `videos/{id}/thumbnail.jpg`.
- A job whose source object is missing/corrupt retries per the backoff policy and, after the final attempt, leaves the video in `error` with a non-null `failure_reason`.
- Re-delivering a job for a video already `ready` does not corrupt it (idempotent).
- The worker runs as a separate process/container — the API container never executes FFmpeg.

---

### SI-03.9 — Get and List Videos (Status Polling)

**Description:** Implement `GET /videos/{publicId}` (single video view with status, metadata, and thumbnail URL) and `GET /videos` (list the caller's own channel videos). The single-get is public for `ready` videos (anonymous viewing of metadata), owner-only otherwise.

**Technical actions:**

- Create `src/videos/dto/video-response.dto.ts` (or a mapper) — shapes the public view: `{ publicId, title, status, durationSeconds, thumbnailUrl, channel: { nickname }, createdAt }` and, for the owner, also `metadata` and `failureReason`. `thumbnailUrl` is `/videos/{publicId}/thumbnail` (served in SI-03.10) or a presigned GET.
- Implement `getByPublicId(publicId, currentUserOrNull)` in `VideosService` — load with channel relation; `VideoNotFoundException` if missing; if `status !== 'ready'` and the caller is not the owner → `VideoNotFoundException` (do not reveal drafts to strangers); return the mapped view.
- Implement `listOwn(userId, pagination)` — list videos of the caller's channel (any status), newest first, paginated.
- Add `@Public() @Get(':publicId')` and `@Get()` (auth required, owner list) to `VideosController`. Because the single-get is `@Public()` but still wants the user when present, read the optional bearer via a lightweight optional-auth path or `@CurrentUser()` tolerant of anonymous.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | getByPublicId maps the view; hides non-ready videos from non-owners; listOwn returns only the caller's videos |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` 200 for a ready video anonymously; 404 for a draft when requested anonymously; owner sees their own draft; `GET /videos` lists only the caller's videos and requires auth |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `GET /videos/{publicId}` for a `ready` video returns 200 with `{ publicId, title, status, durationSeconds, thumbnailUrl, channel }` — accessible anonymously.
- `GET /videos/{publicId}` for a `draft`/`processing` video by a non-owner returns 404 (drafts are not revealed).
- The owner can `GET` their own video in any status and sees `status` progressing `draft → uploading → processing → ready`.
- `GET /videos` (authenticated) lists only the caller's channel videos, newest first.

---

### SI-03.10 — Streaming (HTTP Range / 206), Download, and Thumbnail

**Description:** Implement `GET /videos/{publicId}/stream` (range-aware, `206 Partial Content`), `GET /videos/{publicId}/download` (attachment), and `GET /videos/{publicId}/thumbnail`. All public; streaming/download restricted to `ready` videos.

**Technical actions:**

- Implement `streamVideo(publicId, rangeHeader, res)` in `VideosService`/controller — load a `ready` video (`VideoNotFoundException`/`VideoNotReadyException`); `headObject(storage_key)` for total size + content-type; parse `Range` (`bytes=start-end`); if absent, respond `200` with the full object stream and `Accept-Ranges: bytes`; if present and valid, `getObjectRange(storage_key, 'bytes=start-end')` and respond `206` with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`, `Content-Type`, piping the stream; on an unsatisfiable range respond `416` (`InvalidRangeException`).
- Implement `downloadVideo(publicId, res)` — stream the full object with `Content-Disposition: attachment; filename="..."`.
- Implement `getThumbnail(publicId, res)` — stream `thumbnail_key` with `image/jpeg` (404 if not yet generated).
- Add `@Public() @Get(':publicId/stream')`, `@Public() @Get(':publicId/download')`, `@Public() @Get(':publicId/thumbnail')` to `VideosController` (use `@Res({ passthrough: false })` to control the streamed response).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | After a full upload→process→ready: `GET /videos/:publicId/stream` with `Range: bytes=0-1023` returns `206` with `Content-Range: bytes 0-1023/<total>` and 1024 bytes; without `Range` returns `200` + `Accept-Ranges: bytes`; an unsatisfiable range returns `416`; `GET /download` returns `200` with `Content-Disposition: attachment`; `GET /thumbnail` returns `200` `image/jpeg`; streaming a non-ready video returns `409 VIDEO_NOT_READY` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` with a `Range` header returns `206 Partial Content` with the correct `Content-Range` and only the requested bytes — playback can start without downloading the whole file.
- `GET /videos/{publicId}/stream` without a `Range` header returns `200` with `Accept-Ranges: bytes`.
- An unsatisfiable range (start beyond EOF) returns `416`.
- `GET /videos/{publicId}/download` returns `200` with `Content-Disposition: attachment` and the full file.
- `GET /videos/{publicId}/thumbnail` returns the generated JPEG.
- Streaming/download of a non-`ready` video returns `409 VIDEO_NOT_READY`.

---

### SI-03.11 — Wire VideosModule into AppModule + OpenAPI

**Description:** Register `VideosModule` in `AppModule`, ensure Swagger/OpenAPI documents the video endpoints, and confirm the global guard/filter/validation apply to the new controller.

**Technical actions:**

- Add `VideosModule` to `AppModule` imports; add `QueueModule` and `StorageModule` where needed (global or via VideosModule).
- Add `@ApiTags('videos')` and response/DTO decorators so the endpoints appear in `openapi.json`; regenerate `openapi.json` if the project pins it (there is an `openapi-export` integration test — keep it green).
- Confirm the global `JwtAuthGuard`, `DomainExceptionFilter`, and `ValidationPipe` apply to `VideosController` (write endpoints authenticated, `@Public()` reads).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/app.module.spec.ts` (or existing) | Unit | AppModule compiles with VideosModule wired |
| `openapi-export.integration-spec.ts` | Integration | The exported OpenAPI includes the video endpoints and remains valid (existing test stays green) |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- The application boots with `VideosModule` registered; all video routes are present in the route table.
- `openapi.json` includes the video endpoints; the OpenAPI export test passes.
- Write endpoints require auth; read/stream/download/thumbnail are public — consistent with the Authorization Matrix.

---

### SI-03.12 — Migration Runner Integration Test (videos)

**Description:** Extend the migration-runner integration test to include the `videos` migration — verifying `runMigrations()` creates the `videos` table (and enum) and `undoLastMigration()` reverts it.

**Technical actions:**

- Update `src/database/migrations.integration-spec.ts` — register the `Video` entity so FK metadata resolves; assert `runMigrations()` now includes the `CreateVideos` migration and that `videos` appears in `information_schema.tables`; assert the status enum type exists; after `undoLastMigration()`, `videos` no longer exists.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations` creates `videos` (+ enum); `undoLastMigration` removes it |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- After `runMigrations()`, the `videos` table and its status enum exist alongside the Phase 02 tables.
- After `undoLastMigration()`, the `videos` table no longer exists.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal id (private) |
| public_id | varchar(16) | unique, not null | 11-char nanoid — the unique public URL identifier (TD-06) |
| channel_id | uuid | FK → channels.id, not null | Owner (TD: videos belong to a channel) |
| title | varchar(200) | not null | Provided on draft creation |
| status | enum | not null, default `'draft'` | `draft \| uploading \| processing \| ready \| error` (TD-08) |
| original_filename | varchar(255) | not null | Sanitized name used in the storage key |
| storage_key | varchar | not null | `videos/{id}/original/{filename}` in the bucket (TD-03) |
| thumbnail_key | varchar | nullable | `videos/{id}/thumbnail.jpg`, set by the worker (TD-04) |
| upload_id | varchar | nullable | S3 multipart UploadId while uploading; cleared on complete/abort (TD-02) |
| size_bytes | bigint | nullable | Declared on draft; confirmed after processing |
| duration_seconds | integer | nullable | Extracted by ffprobe (TD-04) |
| metadata | jsonb | nullable | `{ width, height, codec, bitrate, ... }` from ffprobe |
| failure_reason | text | nullable | Set when `status = 'error'` (TD-08) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, via `channel_id`); Channel → Video (one-to-many, `videos`).
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK/list queries.

---

### API Contracts

#### POST /videos (SI-03.5)
- **Auth:** required (Bearer access token). Scoped to the caller's channel.
- **Body:** `title` (string, 1–200), `filename` (string), `sizeBytes` (int, 1..10GB), `contentType` (string, optional)
- **201:** `{ publicId, uploadId, storageKey, partSize, status: 'draft' }`
- **Errors:** 401 (no token); 400 (validation); 413 `UPLOAD_TOO_LARGE` (sizeBytes > 10GB)

#### POST /videos/{publicId}/upload/part-urls (SI-03.6)
- **Auth:** required, owner only.
- **Body:** `partNumbers` (int[], non-empty)
- **201:** `[{ partNumber, url }]` — presigned PUT URLs (client uploads parts directly to MinIO)
- **Errors:** 401; 403 `FORBIDDEN_VIDEO_ACCESS`; 404 `VIDEO_NOT_FOUND`; 409 `UPLOAD_NOT_COMPLETABLE` (wrong state)

#### POST /videos/{publicId}/upload/complete (SI-03.7)
- **Auth:** required, owner only.
- **Body:** `parts` (`[{ partNumber, eTag }]`, non-empty)
- **200:** the video view with `status: 'processing'`
- **Errors:** 401; 403; 404; 409 `UPLOAD_NOT_COMPLETABLE`

#### POST /videos/{publicId}/upload/abort (SI-03.7)
- **Auth:** required, owner only.
- **204:** No content (multipart aborted, draft removed)
- **Errors:** 401; 403; 404; 409

#### GET /videos/{publicId} (SI-03.9)
- **Auth:** public for `ready` videos; owner for non-ready.
- **200:** `{ publicId, title, status, durationSeconds, thumbnailUrl, channel: { nickname }, createdAt }` (+ `metadata`, `failureReason` for owner)
- **Errors:** 404 `VIDEO_NOT_FOUND` (missing, or non-ready requested by a non-owner)

#### GET /videos (SI-03.9)
- **Auth:** required. Lists the caller's channel videos (any status), newest first, paginated.
- **200:** `{ items: VideoView[], total, page, pageSize }`
- **Errors:** 401

#### GET /videos/{publicId}/stream (SI-03.10)
- **Auth:** public; `ready` videos only.
- **Request header:** `Range: bytes=start-end` (optional)
- **206:** partial stream with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`, `Content-Type`
- **200:** full stream (no Range) with `Accept-Ranges: bytes`
- **Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY`; 416 `INVALID_RANGE`

#### GET /videos/{publicId}/download (SI-03.10)
- **Auth:** public; `ready` only.
- **200:** full object stream, `Content-Disposition: attachment; filename="..."`
- **Errors:** 404; 409 `VIDEO_NOT_READY`

#### GET /videos/{publicId}/thumbnail (SI-03.10)
- **Auth:** public.
- **200:** `image/jpeg` stream
- **Errors:** 404 (video or thumbnail not found)

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-scoped | Notes |
|----------|--------|---------------|--------------|-------|
| POST /videos | | ✓ | ✓ (creates in caller's channel) | Pre-registers draft + initiates upload |
| POST /videos/:publicId/upload/part-urls | | ✓ | ✓ | Presigned part URLs |
| POST /videos/:publicId/upload/complete | | ✓ | ✓ | Finalize + enqueue processing |
| POST /videos/:publicId/upload/abort | | ✓ | ✓ | Cancel upload |
| GET /videos | | ✓ | ✓ (own list) | |
| GET /videos/:publicId | ✓ (ready) | (owner for non-ready) | | Drafts hidden from strangers |
| GET /videos/:publicId/stream | ✓ | | | `ready` only — anonymous watching |
| GET /videos/:publicId/download | ✓ | | | `ready` only |
| GET /videos/:publicId/thumbnail | ✓ | | | |

---

### Error Catalog

Extends the Phase 02 error contract `{ statusCode, error, message }` (phase-02-auth/TD-07). New codes:

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `publicId`, or a non-ready video requested by a non-owner |
| FORBIDDEN_VIDEO_ACCESS | 403 | You do not own this video | Upload/manage operation on a video of another channel |
| UPLOAD_TOO_LARGE | 413 | Upload exceeds the maximum allowed size | `sizeBytes` > 10GB on create |
| UPLOAD_NOT_COMPLETABLE | 409 | Upload cannot be completed in the current state | part-urls/complete/abort on a video not in `draft`/`uploading` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | stream/download of a non-`ready` video |
| INVALID_RANGE | 416 | Requested range not satisfiable | `Range` header start beyond EOF |

---

### Events / Messages (Queue) — TD-01, TD-08

**Queue:** `video-processing` (BullMQ over Redis; connection host = Compose service `redis`).

**Producer:** the API, in `POST /videos/:publicId/upload/complete` (SI-03.7), after the multipart upload is finalized and the video is set to `processing`.

**Job:**

| Field | Value |
|-------|-------|
| Job name | `process` |
| Payload | `{ videoId: string }` — internal id only; the worker re-reads the row (single source of truth) |
| Options | `attempts: VIDEO_PROCESSING_ATTEMPTS` (default 3); `backoff: { type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS }`; `removeOnComplete: true`; `removeOnFail: false` |
| Delivery | at-least-once → the processor MUST be idempotent (no-op if already `ready`) |

**Consumer:** the `video-worker` container (`@Processor('video-processing')`, SI-03.8).

**Status transitions driven by the queue:**

```
POST /videos                    → status = draft         (row pre-registered, multipart initiated)
POST .../upload/part-urls       → status = uploading     (first call)
POST .../upload/complete        → status = processing    + enqueue { videoId }
worker process() success        → status = ready         (+ duration, metadata, thumbnail_key)
worker process() final failure  → status = error         (+ failure_reason) after attempts exhausted
POST .../upload/abort           → draft removed / upload aborted
```

**Failure handling:** BullMQ retries with exponential backoff; on the final failed attempt, `@OnWorkerEvent('failed')` sets the video to `error` with `failure_reason`. Failed jobs are retained (`removeOnFail: false`) for inspection. No dead-letter queue is needed for a single job type at this scale.

---

## Dependency Map

```
SI-03.1 (no deps — deps, config, Compose: minio + redis + video-worker + FFmpeg image)
├── SI-03.2 (Storage service)
├── SI-03.3 (Queue producer)
└── SI-03.12 depends on SI-03.4

SI-03.2 + SI-03.3
└── SI-03.4 (Video entity + migration + VideosModule)
    └── SI-03.5 (create draft + initiate multipart)
        └── SI-03.6 (presign part URLs)
            └── SI-03.7 (complete + enqueue)
                └── SI-03.8 (worker: process + metadata + thumbnail)
                    └── SI-03.9 (get/list + status polling)
                        └── SI-03.10 (stream 206 + download + thumbnail)
                            └── SI-03.11 (wire into AppModule + OpenAPI)

SI-03.4
└── SI-03.12 (migration runner test)
```

Linearized order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11; SI-03.12 after SI-03.4 (parallel with the upload chain).

---

## Deliverables

- [ ] MinIO (object storage), Redis (queue), and a `video-worker` service running via `docker compose up`, alongside the backend
- [ ] `storage` + `queue` config namespaces (env-driven; hosts = Compose service names); Joi + `.env.example` updated
- [ ] `StorageService` over `@aws-sdk/client-s3` against MinIO: presigned multipart, ranged read, put, delete-by-prefix
- [ ] BullMQ `video-processing` queue producer + a separate worker container consuming it
- [ ] `Video` entity linked to `Channel`, with status lifecycle, storage keys, unique `public_id`, duration/metadata; migration `CreateVideos`
- [ ] Upload of up to 10GB via presigned multipart — the file never passes through the API; draft pre-registered at start
- [ ] Automatic processing after upload: ffprobe duration/metadata + FFmpeg thumbnail; status `processing → ready`
- [ ] Unique public video URL (`public_id`, nanoid) with no conflicts
- [ ] Streaming with HTTP Range / `206 Partial Content` (playback without full download) + download endpoint
- [ ] Status lifecycle `draft → uploading → processing → ready | error` reflected in the DB, with terminal `error` + `failure_reason` on processing failure
- [ ] Video endpoints in OpenAPI; global guard/filter/validation applied; anonymous stream/download of `ready` videos
- [ ] Migration runner integration test covers the `videos` migration (apply + revert)
- [ ] `progress.md` updated per SI (status + tests)
- [ ] Definition of Done: full suite green (`docker compose exec nestjs-api npm test` + `npm run test:e2e`), `npx tsc --noEmit` (code 0), `npm run lint`
- [ ] Git Flow: implemented on a `feature/*` branch from `dev`, no direct commits to `main`
- [ ] `CLAUDE.md` updated with the videos section (module, endpoints, queue/worker, storage) consistent with the code
