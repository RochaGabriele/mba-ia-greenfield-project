---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-07
scope_description: "Backend foundation for video upload and processing: message queue technology, large-file (10GB) upload strategy, object-storage key organization, background worker execution model, video processing/thumbnail extraction, unique public URL generation, streaming strategy, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend API that exposes the video module (create draft, presign upload, complete upload, list/get, stream, download), plus the new infrastructure it orchestrates: object storage (MinIO/S3), a message queue, and a background video worker.
- `next-frontend/` — Frontend deferred: the video UI (upload widget, player) is out of scope for this backend phase and will be addressed in Fases 04–05. No open decision in this document.

_Given (not open decisions):_

- **Object storage is S3-compatible MinIO** (per `docs/diagrams/software-arch.mermaid` and `docs/project-plan.md`). This document decides *how* to use it (SDK, bucket/key layout, presigned uploads), not *whether* to use it. See TD-03.

---

## TD-01: Message Queue Technology

**Scope:** Backend / Infra

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram marks the Message Queue as **TBD** — this is the primary stack decision of the phase. Video processing (metadata extraction, thumbnail) is heavy and must run in a background worker, decoupled from the request/response cycle. The queue must deliver jobs from the API to the worker reliably, survive restarts, and support retries and failure handling. The project already runs PostgreSQL 17 in Docker and everything runs via Docker Compose.

**Options:**

### Option A: BullMQ (Redis-backed) via `@nestjs/bullmq`
- Redis-backed job queue with a first-party NestJS integration (`@nestjs/bullmq`). Producers add jobs with `Queue.add()`; the worker consumes via a `@Processor()` class. Built-in retries with backoff, delayed jobs, concurrency, rate limiting, progress events, and a dead-letter equivalent (failed set).
- **Pros:** First-class NestJS integration (`BullModule.registerQueue`, `@Processor`, `WorkerHost`) — DI-native producer and consumer. Purpose-built for background jobs: retries/backoff, concurrency, priorities, delayed/repeatable jobs, and job progress out of the box. Redis is a single lightweight container. Huge adoption; the de-facto Node.js job queue. Worker can run as a separate process/container sharing the same NestJS codebase.
- **Cons:** Adds Redis as new infrastructure (one more Compose service). At-least-once delivery — handlers must be idempotent. Redis persistence must be configured (AOF) to survive restarts.

### Option B: RabbitMQ (AMQP) via NestJS microservices transport
- A dedicated message broker; NestJS supports it via `@nestjs/microservices` (`Transport.RMQ`). API publishes to an exchange/queue; the worker is a microservice consumer.
- **Pros:** Broker-grade routing (exchanges, dead-letter exchanges, TTL), strong delivery guarantees with manual ack, mature operational tooling.
- **Cons:** Heavier to operate for a single job type (management of exchanges/bindings). The NestJS microservices programming model is request/response-oriented; long-running video jobs fit the pattern awkwardly (no native job retries/backoff/progress like BullMQ). More moving parts than the phase needs.

### Option C: pg-boss (PostgreSQL-backed queue)
- A job queue implemented on top of the existing PostgreSQL using `SKIP LOCKED`. No new datastore.
- **Pros:** Zero new infrastructure — reuses PostgreSQL already in the stack. Transactional enqueue (a job can be enqueued in the same DB transaction that creates the video row). Retries and scheduling supported.
- **Cons:** No official NestJS integration — custom wiring for producer and worker. Queue load competes with the primary DB for connections/IO. Smaller ecosystem than BullMQ; fewer job-management features (progress, concurrency controls) and less battle-tested at high video throughput.

### Option D: Cloud managed queue (AWS SQS)
- Managed queue via `@ssut/nestjs-sqs` or the AWS SDK.
- **Pros:** Fully managed, scales infinitely, no infra to run in production.
- **Cons:** Not runnable locally without emulation (LocalStack/ElasticMQ) — contradicts the "everything runs in Docker Compose and is exercised by real tests" rule. Vendor lock-in. FIFO/visibility-timeout semantics add complexity. Overkill for the phase's local-first requirement.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — It is the purpose-built Node.js background-job solution with a first-party NestJS module, giving DI-native producers/consumers, built-in retries/backoff/concurrency, and a clean separation between the API (producer) and a separate worker container (consumer) sharing one codebase. Redis is a single small container that runs in Compose and is exercised by real integration/e2e tests, satisfying the "real infra, tested" rule. pg-boss avoids new infra but lacks NestJS integration and job-management features; RabbitMQ and SQS are heavier than a single video-processing job type warrants.

**Decision:** A (BullMQ + Redis, via `@nestjs/bullmq`)

---

## TD-02: Large-File (10GB) Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must never be buffered or streamed *through* the NestJS API — doing so would pin a Node.js process, exhaust memory/timeouts, and block the event loop (an explicit "reprova automática" in the brief). The client must send the bytes to object storage directly, with the API only orchestrating (authorize, pre-register the draft, finalize).

**Options:**

### Option A: Presigned Multipart Upload direct to S3/MinIO
- The API creates the draft video row, then initiates an S3 multipart upload and returns presigned URLs (one per part) to the client. The client PUTs each part directly to MinIO, then calls the API to `CompleteMultipartUpload`. The file never touches the API.
- **Pros:** Handles arbitrarily large files (S3 multipart supports up to 5TB; parts of 5MB–5GB). Resumable/retriable per part (a failed part is re-uploaded without restarting the whole file — matches the project-plan "retomar em caso de falha" note). The API stays stateless and fast — it only signs URLs and records the completion. Native S3/MinIO feature; no extra library beyond the AWS SDK presigner.
- **Cons:** More endpoints (create → get part URLs → complete/abort). Client must orchestrate part splitting and completion (acceptable — real clients / test harness do this). ETag bookkeeping per part on completion.

### Option B: Single Presigned PUT direct to S3/MinIO
- The API returns one presigned PUT URL; the client uploads the whole file in a single request directly to storage.
- **Pros:** Simplest — one URL, one PUT. File still bypasses the API.
- **Cons:** A single PUT is capped at 5GB in S3/MinIO — **cannot** satisfy the 10GB requirement. No resumability — a dropped connection at 9GB restarts from zero. Rejected for exceeding the hard size limit.

### Option C: Stream the upload through the API (multipart/form-data or tus)
- The client uploads to a NestJS endpoint, which streams the bytes to storage.
- **Pros:** Single origin; the API can enforce validation mid-stream.
- **Cons:** The 10GB file passes through the API — the exact anti-pattern the brief forbids ("passar o arquivo inteiro pela API é o caminho errado"). Ties up a Node process and risks timeouts/memory pressure. Rejected.

**Recommendation:** **Option A (Presigned Multipart Upload)** — It is the only option that meets the 10GB requirement without routing bytes through the API, and it provides per-part resumability (aligning with the project-plan's "retomar em caso de falha"). The client PUTs parts straight to MinIO using presigned URLs; the API only creates the draft, signs URLs, and finalizes the upload — staying stateless and fast. Single-PUT (B) is capped at 5GB and non-resumable; through-API streaming (C) is the forbidden anti-pattern.

**Decision:** A (Presigned Multipart Upload direct to MinIO/S3)

---

## TD-03: Object Storage Access and Key Organization

**Scope:** Backend / Infra

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is a given (MinIO locally, S3 in prod). The open sub-decisions are the client library, bucket topology, and object key scheme — these must support presigned multipart (TD-02), worker access (TD-05), streaming/download (TD-07), and avoid key collisions.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, single bucket, prefixed keys
- Official AWS SDK v3 pointed at the MinIO endpoint (`forcePathStyle: true`). One bucket (`streamtube-videos`) with keys prefixed by type and scoped by video id: `videos/{videoId}/original/{filename}` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Official, MinIO-compatible SDK (MinIO implements the S3 API). Presigner package generates the multipart part URLs from TD-02. A single bucket with per-video prefixes keeps all artifacts of a video co-located and trivially deletable (`videos/{videoId}/` prefix). Path-style addressing works with MinIO's host:port endpoint.
- **Cons:** Two packages (client + presigner). Bucket must be created on startup/first boot (a small idempotent "ensure bucket" step).

### Option B: `minio` JS SDK, bucket-per-type
- The MinIO-specific SDK, with separate buckets for videos and thumbnails.
- **Pros:** Slightly terser MinIO API; presigned URLs built-in.
- **Cons:** Couples the code to the MinIO SDK — swapping to real S3 in production means an SDK change, defeating the "S3-compatible" intent. Bucket-per-type scatters a video's artifacts across buckets, complicating deletion and lifecycle. Rejected to keep S3 portability.

**Recommendation:** **Option A (`@aws-sdk/client-s3` + presigner, single bucket, per-video key prefix)** — Using the official S3 SDK against MinIO keeps the code portable to real S3 in production with only an endpoint/credentials change. A single bucket with `videos/{videoId}/...` prefixes co-locates the original and thumbnail per video (simple lifecycle and deletion) and produces the unique keys needed for presigned multipart. `forcePathStyle: true` is required for MinIO's endpoint addressing.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; single bucket `streamtube-videos`; keys `videos/{videoId}/original/{originalName}` and `videos/{videoId}/thumbnail.jpg`)

---

## TD-04: Video Processing and Thumbnail Generation

**Scope:** Backend / Worker

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After the upload completes, the worker must extract duration and metadata (codec, resolution, size) and generate a thumbnail from a representative frame. The tool is FFmpeg (per the architecture diagram's "Video Worker (FFmpeg)"). The decision is how the worker invokes FFmpeg/ffprobe and sources the input.

**Options:**

### Option A: `fluent-ffmpeg` wrapper + system FFmpeg (installed in the worker image), streaming input from storage
- The worker image (Debian/Alpine node) installs the `ffmpeg` package (which includes `ffprobe`). `fluent-ffmpeg` provides a typed Node API: `ffprobe()` for metadata and `.screenshots()`/`.thumbnail()` for a frame. Input is a presigned GET URL (or a temporary local download) of the original from storage; the thumbnail is uploaded back to storage.
- **Pros:** `fluent-ffmpeg` is the standard Node FFmpeg wrapper — readable API for probe and thumbnail, avoids hand-building shell commands. Using the OS `ffmpeg`/`ffprobe` (apt) gives a full, up-to-date build. `ffprobe -show_format -show_streams` yields duration + all metadata. `.screenshots({ timestamps: ['10%'], size: '1280x720' })` captures a mid-video frame reliably.
- **Cons:** `fluent-ffmpeg` is in maintenance mode — mitigated by pinning the version and relying on the stable probe/screenshot APIs. Requires FFmpeg in the worker image (a `Dockerfile` apt install). For very large files, downloading to a temp file (or streaming) must be managed; ffprobe over a presigned URL avoids a full download for metadata.

### Option B: Spawn `ffmpeg`/`ffprobe` via `child_process` directly (no wrapper)
- The worker shells out to `ffprobe`/`ffmpeg` and parses JSON output.
- **Pros:** No extra dependency; full control of the command line; not tied to a maintenance-mode wrapper.
- **Cons:** More boilerplate (argument building, stream/stdout parsing, error handling) that `fluent-ffmpeg` already solves. Easier to introduce injection/quoting bugs. Reinvents a well-worn wheel.

**Recommendation:** **Option A (`fluent-ffmpeg` + system FFmpeg)** — The wrapper gives a clean, typed API for the two operations the phase needs (probe for duration/metadata, screenshot for the thumbnail) with far less error-prone code than hand-spawning processes. Installing FFmpeg in the worker image matches the architecture's "Video Worker (FFmpeg)". The maintenance-mode risk is contained by pinning the version and using only the stable probe/screenshot surface. ffprobe reads metadata from a presigned URL without downloading the full 10GB; the thumbnail frame is extracted and uploaded to `videos/{videoId}/thumbnail.jpg`.

**Decision:** A (`fluent-ffmpeg` + FFmpeg/ffprobe installed in the worker image; duration+metadata via ffprobe, thumbnail via a single-frame screenshot at ~10% of the duration)

---

## TD-05: Video Worker Execution Model

**Scope:** Backend / Infra

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The worker consumes the queue (TD-01) and runs FFmpeg (TD-04). It must be a separate unit of execution from the API (so heavy processing never blocks request handling) while reusing the project's code (entities, config, storage service).

**Options:**

### Option A: Separate container from the same codebase, running a NestJS standalone app that hosts the BullMQ `@Processor`
- A second Compose service (`video-worker`) built from the same `nestjs-project` image but with a different entrypoint (`worker.ts` bootstrapping `NestFactory.createApplicationContext(WorkerModule)`). It shares entities, `TypeOrmModule`, the storage service, and the BullMQ processor. FFmpeg is added to the image.
- **Pros:** One codebase, one Docker image — no duplication of entities/config/storage. DI works normally (the processor injects the video repository and storage service). Clear process isolation: the API container never runs FFmpeg. Scales independently (`docker compose up --scale video-worker=N`). Testable: integration tests can drive the same processor logic against real Redis + MinIO + Postgres.
- **Cons:** A second entrypoint (`worker.ts`) and a `WorkerModule` to wire. The image must include FFmpeg even for the API container (or use a separate build stage) — mitigated by a shared base with FFmpeg only where needed.

### Option B: In-process worker inside the API container
- The `@Processor` runs inside the same Nest app as the API (same process).
- **Pros:** Simplest wiring — no second service or entrypoint.
- **Cons:** FFmpeg CPU/IO shares the API process/container — a heavy job degrades request latency, violating "sem impactar a performance do sistema". Cannot scale the worker independently. Rejected — defeats the purpose of a background worker.

**Recommendation:** **Option A (separate `video-worker` container, same codebase, NestJS standalone application context hosting the BullMQ processor)** — It gives true process isolation (the API never runs FFmpeg) while reusing entities, config, storage, and DI through a dedicated `WorkerModule` and `worker.ts` entrypoint. It scales independently and is exercised by real integration/e2e tests against Redis + MinIO + Postgres in Compose. The in-process option (B) reintroduces the coupling the phase exists to remove.

**Decision:** A (separate `video-worker` Compose service from the same image, `worker.ts` bootstrapping a standalone `WorkerModule` with the BullMQ `@Processor`; FFmpeg installed in the worker image)

---

## TD-06: Unique Public Video URL / Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe public identifier that never collides — used in playback/download URLs (e.g., `/videos/{publicId}/stream`). This is distinct from the internal `uuid` primary key (kept private).

**Options:**

### Option A: `nanoid` short id (e.g., 11 chars, URL-safe alphabet), unique column
- Generate an 11-character `nanoid` (`A-Za-z0-9_-`) stored in a `public_id` column with a unique constraint; retry on the (astronomically rare) collision.
- **Pros:** Short and URL-friendly (YouTube-style handles). ~11 chars gives ~10^19 space — collision probability negligible; the unique constraint + retry is a safety net. Decouples the public URL from the internal `uuid` (no enumeration of DB ids). Tiny, well-known dependency.
- **Cons:** One small dependency (`nanoid`). Requires a uniqueness check/retry (trivial with a unique index).

### Option B: Reuse the entity `uuid` primary key as the public id
- Expose the `uuid` PK directly in URLs.
- **Pros:** No extra column or library; already unique.
- **Cons:** 36-char UUIDs are long and ugly in URLs. Leaks the internal primary key (enumeration/ID-exposure surface). Not the "short unique URL" the project-plan asks for ("URL curta e única").

### Option C: Auto-increment + Hashids/Sqids encoding
- Encode a sequential integer id into a short slug.
- **Pros:** Short, decodable.
- **Cons:** Sequential ids are guessable/enumerable even after encoding; the salt becomes a secret to manage. More moving parts than nanoid for the same outcome.

**Recommendation:** **Option A (`nanoid`, 11-char `public_id`, unique column with retry)** — It delivers the short, non-enumerable, collision-free public URL the project-plan calls for, keeps the internal `uuid` PK private, and costs one tiny dependency plus a unique index. UUID-in-URL (B) is long and leaks the PK; Hashids (C) is guessable and adds salt management.

**Decision:** A (`nanoid` 11-char `public_id`, unique DB column, generate-and-retry on unique violation)

---

## TD-07: Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, and a separate download must be available. HTML5 `<video>` requests byte ranges (`Range: bytes=...`) and expects `206 Partial Content`. The bytes live in MinIO/S3. The decision is where the range logic lives.

**Options:**

### Option A: API streaming endpoint that proxies HTTP Range to storage (`206 Partial Content`)
- `GET /videos/{publicId}/stream` reads the `Range` header, issues a ranged `GetObject` to storage (S3 supports `Range`), and pipes the partial stream back with `206`, `Content-Range`, `Accept-Ranges: bytes`, and `Content-Type`. `GET /videos/{publicId}/download` streams the full object with `Content-Disposition: attachment`.
- **Pros:** Standards-correct HTML5 streaming — the browser seeks via ranges; playback starts immediately. The API controls access (visibility rules, future auth) and never buffers the whole file (it pipes a bounded range). S3/MinIO honor the `Range` on `GetObject`, so the API forwards a small window at a time. Download reuses the same object-streaming path with attachment headers. Only `ready` videos are streamable — the endpoint enforces status.
- **Cons:** Bytes transit the API (bounded per-range, not the whole file) — more egress through the API than a direct-to-storage redirect. Must implement range parsing and error cases (416 Range Not Satisfiable).

### Option B: Redirect to a presigned GET URL (client streams directly from storage)
- The API returns a presigned URL; the browser/player streams ranges directly from MinIO/S3.
- **Pros:** Zero video bytes through the API — most scalable; matches the C4 "Frontend streams from Object Storage" arrow.
- **Cons:** Access control is only as strong as the URL's TTL (bearer URL). Harder to enforce per-request visibility/ownership at play time. MinIO must be reachable by the client (in local Compose, the browser's host differs from the internal service name — presigned URLs need a host the client can reach). For a backend phase focused on correctness and testability, proxying is simpler to exercise end-to-end.

**Recommendation:** **Option A (API range-proxy streaming, `206 Partial Content`)** — It is the standards-correct way to make HTML5 playback start without a full download, keeps access control in the API (status/visibility enforced per request), and only pipes a bounded byte range at a time (never the whole 10GB). Download reuses the same object stream with attachment headers. The presigned-redirect (B) is more scalable but weakens per-request access control and is harder to exercise reliably in local Compose tests; it can be adopted later behind the same endpoint contract without changing clients.

**Decision:** A (API `GET /videos/{publicId}/stream` proxying `Range` → storage with `206`/`Content-Range`; `GET /videos/{publicId}/download` streaming the full object as an attachment; both restricted to `ready` videos)

---

## TD-08: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo

**Context:** A video row exists before its bytes do (pre-registered as a draft when the upload starts) and moves through states as it is uploaded and processed. The lifecycle and the behavior on processing failure must be explicit so the DB always reflects reality and clients can poll status.

**Options:**

### Option A: Explicit status enum `draft → uploading → processing → ready | error`, BullMQ retries then terminal `error`
- On create, status is `draft`. When the client finalizes the multipart upload, the API sets `uploading → processing` and enqueues a `video.process` job. The worker sets `processing`, runs probe+thumbnail, and on success sets `ready` (persisting duration/metadata/thumbnail key). On failure, BullMQ retries with backoff (e.g., 3 attempts); after the final attempt, the worker/queue failure handler sets status `error` and records a failure reason. Only `ready` videos are streamable/downloadable.
- **Pros:** Each state maps to an observable reality (row exists as draft, bytes uploaded, job running, done/failed). Clients poll `GET /videos/{publicId}` for status. Retries absorb transient FFmpeg/storage hiccups; a terminal `error` state prevents stuck "processing" rows (no ghost jobs). Idempotent handler (safe to re-run) fits BullMQ's at-least-once delivery.
- **Cons:** More states to manage and test. Needs a failure hook (`Worker` `failed` event or `@OnWorkerEvent('failed')`) to mark `error` after retries exhaust.

### Option B: Boolean `is_ready` flag only
- A single boolean toggled true when processing finishes.
- **Pros:** Simplest schema.
- **Cons:** Cannot distinguish `draft` vs `uploading` vs `processing` vs `error` — a failed or half-uploaded video is indistinguishable from a not-yet-processed one. No terminal failure signal for clients. Rejected — the brief explicitly requires "Ciclo de status do vídeo (rascunho → processando → pronto/erro) refletido no banco".

**Recommendation:** **Option A (explicit status enum with BullMQ retries and a terminal `error` state)** — It satisfies the brief's explicit requirement for a `rascunho → processando → pronto/erro` lifecycle reflected in the database, gives clients a pollable status, and handles processing failures deterministically (bounded retries, then a terminal `error` with a recorded reason). The boolean flag (B) cannot represent the required states.

**Decision:** A (status enum `draft | uploading | processing | ready | error`; BullMQ job with 3 attempts + exponential backoff; terminal `error` + `failure_reason` after retries exhaust; only `ready` videos are streamable/downloadable)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|----------------|--------|
| TD-01 | Message Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Large-File (10GB) Upload Strategy | Presigned Multipart Upload | A (Presigned Multipart, direct to MinIO) |
| TD-03 | Object Storage Access & Key Layout | AWS SDK v3 + presigner, single bucket, per-video prefix | A (`@aws-sdk/client-s3` + presigner) |
| TD-04 | Video Processing & Thumbnail | `fluent-ffmpeg` + system FFmpeg | A (`fluent-ffmpeg` + FFmpeg in worker image) |
| TD-05 | Worker Execution Model | Separate worker container, same codebase | A (standalone `video-worker` + BullMQ processor) |
| TD-06 | Unique Public Video URL | `nanoid` 11-char `public_id` | A (`nanoid` unique column + retry) |
| TD-07 | Streaming Strategy | API range-proxy (`206 Partial Content`) | A (API stream/download endpoints) |
| TD-08 | Status Lifecycle & Failure Handling | Explicit enum + BullMQ retries → terminal error | A (`draft→uploading→processing→ready\|error`) |
