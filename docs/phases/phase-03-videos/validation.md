---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-07T18:30:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-07T18:20:00-03:00"
issues: []
advisories: []
---

# phase-03-videos — Validation

Validation ran against `context.md` and the decisions document. The first pass surfaced six issues
(one missing decision, three dependency gaps, one ambiguity, one inherited-constraint check); all were
resolved by the `plan-resolve` step (decisions/context updated and libraries pinned in
`library-refs.md`). Current status: **clean**.

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None — video UI is explicitly deferred to Fases 04–05 (see context `Non-UI / Deferred Capabilities`)._

## Resolved Issues

| # | Type | Finding (first pass) | Resolution |
|---|------|----------------------|------------|
| 1 | Missing Decision | The architecture diagram left the Message Queue as **TBD** — no queue technology decided; the "background processing" capability had no covering decision. | Added **TD-01** (BullMQ + Redis via `@nestjs/bullmq`) with a four-option trade-off analysis; capability "Serviço de processamento em segundo plano (filas)" now maps to TD-01 + TD-05. |
| 2 | Dependency Gap | The 10GB upload capability referenced no concrete mechanism — risk of the forbidden "stream through the API" anti-pattern. | Added **TD-02** (Presigned Multipart Upload direct to MinIO) tying the capability to a bounded API role (create draft, sign parts, finalize). |
| 3 | Dependency Gap | The worker needs FFmpeg, but the base image (`Dockerfile.dev`) does not install it, and no worker entrypoint exists. | **TD-04** + **TD-05** pin `fluent-ffmpeg` + a worker image with FFmpeg installed and a standalone `worker.ts` entrypoint hosting the BullMQ `@Processor`. SI-03.1 adds the worker Dockerfile/Compose service. |
| 4 | Dependency Gap | New runtime services (MinIO, Redis) and new env vars (bucket, endpoint, credentials, Redis host/port) were not reflected in config/Compose. | SI-03.1 adds `storage.config.ts` + `queue.config.ts`, extends the Joi schema and `.env.example`, and adds `minio` + `redis` + `video-worker` services to `compose.yaml` (hosts by Compose service name, per CLAUDE.md). |
| 5 | Ambiguity | "URL única por vídeo" did not specify the identifier scheme, risking exposure of the internal `uuid` PK in URLs. | **TD-06** decides an 11-char `nanoid` `public_id` (unique column + retry), keeping the `uuid` PK private. |
| 6 | Inherited Constraint Check | Streaming/download access rules vs. the global `JwtAuthGuard` (Phase 02) — anonymous watching is required by the project-plan. | **TD-07** + context "Inherited Decisions Detail": stream/download endpoints are `@Public()` (anonymous watching); write endpoints (create/presign/complete) require auth and are scoped to the caller's channel. No conflict. |

_All resolved — no open issues remain._
