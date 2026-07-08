---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-07T18:20:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, visibilidade público/unlisted, categorias, painel de gerenciamento, página pública do canal (Fase 04); player e página de visualização (Fase 05); likes/comentários/inscrições (Fase 06). Frontend de vídeo (upload widget, player) — diferido.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — o upload widget e o player ficam diferidos para as Fases 04–05 (UI de vídeo fora do escopo deste desafio de backend).

**Sequencing notes:** Depends on Fase 01 (Configuração Base) e Fase 02 (Auth/Users/Channels). Vídeos pertencem a um canal (relação com `channels`, criado no cadastro).

**Neighbors (for boundary detection only):** Fase 02 — Auth (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend/Infra | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq@^5.x, @nestjs/bullmq@^11.x, ioredis@^5.x (transitive) |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Large-File (10GB) Upload Strategy | decided | A (Presigned Multipart Upload) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend/Infra | Object Storage Access & Key Layout | decided | A (AWS SDK v3, single bucket, per-video prefix) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend/Worker | Video Processing & Thumbnail | decided | A (fluent-ffmpeg + system FFmpeg) | fluent-ffmpeg@^2.1.x, @types/fluent-ffmpeg@^2.1.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend/Infra | Worker Execution Model | decided | A (separate worker container, same codebase) | @nestjs/bullmq@^11.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL | decided | A (nanoid 11-char public_id) | nanoid@^5.x |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming Strategy | decided | A (API range-proxy, 206 Partial Content) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Status Lifecycle & Failure Handling | decided | A (enum draft→uploading→processing→ready\|error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis via `@nestjs/bullmq`) — Purpose-built Node.js background-job queue with a first-party NestJS module; DI-native producer/consumer, built-in retries/backoff/concurrency, and clean API↔worker separation. Redis is a single small Compose container exercised by real tests. pg-boss lacks NestJS integration and job features; RabbitMQ/SQS are heavier than one job type warrants.

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (Presigned Multipart Upload direct to MinIO/S3) — Only option that meets 10GB without routing bytes through the API, with per-part resumability. The API creates the draft, signs part URLs, and finalizes; the client PUTs parts straight to storage. Single-PUT is capped at 5GB; through-API streaming is the forbidden anti-pattern.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A (AWS SDK v3 + presigner, single bucket `streamtube-videos`, per-video key prefix) — Official S3 SDK against MinIO (`forcePathStyle: true`) keeps the code portable to real S3. Per-video prefixes (`videos/{videoId}/...`) co-locate original + thumbnail for simple lifecycle/deletion and produce unique keys for multipart.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Option A (`fluent-ffmpeg` + system FFmpeg in worker image) — Typed API for probe (duration/metadata) and single-frame thumbnail, far less error-prone than hand-spawned processes; matches the "Video Worker (FFmpeg)" container. ffprobe reads metadata from a presigned URL without downloading the full file. Maintenance-mode risk contained by pinning.

**Libraries:** `fluent-ffmpeg@^2.1.x`, `@types/fluent-ffmpeg@^2.1.x`

### phase-03-videos/TD-05

**Recommendation:** Option A (separate `video-worker` container from the same image; `worker.ts` bootstraps a standalone `WorkerModule` hosting the BullMQ `@Processor`; FFmpeg in the worker image) — True process isolation (API never runs FFmpeg) while reusing entities/config/storage via DI; scales independently; exercised by real tests against Redis + MinIO + Postgres.

**Libraries:** `@nestjs/bullmq@^11.x`

### phase-03-videos/TD-06

**Recommendation:** Option A (`nanoid` 11-char `public_id`, unique column + retry) — Short, non-enumerable, collision-free public URL; keeps the internal `uuid` PK private; one tiny dependency + unique index. UUID-in-URL is long and leaks the PK; Hashids is guessable.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-07

**Recommendation:** Option A (API range-proxy streaming, `206 Partial Content`) — Standards-correct HTML5 playback that starts without a full download; access control stays in the API (status/visibility per request); only a bounded byte range transits the API. Download reuses the same object stream with attachment headers. Presigned-redirect can be adopted later behind the same contract.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option A (explicit status enum + BullMQ retries → terminal `error`) — Satisfies the required `rascunho → processando → pronto/erro` lifecycle reflected in the DB; pollable status; deterministic failure handling (bounded retries then terminal `error` + reason). Boolean flag cannot represent the required states.

**Libraries:** —

## Inherited Decisions Detail

The video module reuses the Phase 01/02 backend foundation without re-deciding it:

### phase-01-configuracao-base/TD-01, TD-03 (Config)

**Recommendation:** `@nestjs/config` with namespaced `registerAs()` factories, one file per domain in `src/config/`, injected via `ConfigType<typeof xxxConfig>`. Phase 03 adds `storage.config.ts`, `queue.config.ts` (and reuses `database.config.ts`) following this pattern.

### phase-02-auth/TD-06 (Validation)

**Recommendation:** `class-validator` + `class-transformer` on DTOs, validated by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`). Video DTOs follow this.

### phase-02-auth/TD-07 (Error Contract)

**Recommendation:** Custom `DomainException` subclasses mapped by the global `DomainExceptionFilter` to `{ statusCode, error, message }`. Phase 03 adds `VideoNotFoundException`, `VideoNotReadyException`, `InvalidRangeException`, `UploadNotCompletableException`, `ForbiddenVideoAccessException` following this contract.

### phase-02-auth/TD-02, SI-02.9 (Auth Guard)

**Recommendation:** Global `JwtAuthGuard` with `@Public()` opt-out. Video write endpoints (create/presign/complete) require auth and are scoped to the caller's channel; streaming/download are `@Public()` (anonymous watching per project-plan).

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`, validated by the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; entities defined per module and registered via `TypeOrmModule.forFeature([...])`; migrations are hand-reviewed and versioned in `src/database/migrations/`. _(from phase 01)_
- HTTP layer: DTOs validated by the global `ValidationPipe`; domain errors surfaced via `DomainException` subclasses + global `DomainExceptionFilter` in the `{ statusCode, error, message }` shape. _(from phase 02)_
- Auth: global `JwtAuthGuard`; `@Public()` to opt out; `@CurrentUser()` to read the JWT payload. _(from phase 02)_
- Layer separation (per `.claude/rules/nestjs-layer-separation.md`): controllers are thin (validation + delegation), services own business logic, repositories own data access; a service must not own another domain's entity — extract to the proper module. _(project rule)_
- Testing pyramid (per `testing-guide-nestjs-project`): `*.spec.ts` unit, `*.integration-spec.ts` against real DB/services, `*.e2e-spec.ts` via supertest. Do not mock what Compose can run for real. _(project rule)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities relevant to Phase 03._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Upload widget / video player UI | deferred | Video UI belongs to Fases 04–05 and is out of scope for this backend phase; `next-frontend/` video surfaces are not built here. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces: the `Video` entity + migration (integration), config namespaces (`storage`, `queue`), a storage service wrapping the S3 SDK against MinIO (integration), a BullMQ producer/queue (integration), the video worker `@Processor` running FFmpeg (integration against real Redis + MinIO + Postgres), the video service + controller (unit + integration), streaming/download endpoints with `Range` handling, and end-to-end flows (`test/videos.e2e-spec.ts`) covering create-draft → presign → complete → process → poll `ready` → stream (`206`) → download. New infra services (MinIO, Redis, video-worker) must be up in Compose and exercised by real tests — not mocked. Specific layer coverage by SI is recorded in `progress.md`.
