---
kind: phase
name: phase-03-videos
stage: complete
implementation_status: completed
---

# phase-03-videos — Progress

Tracks implementation status and test coverage per Step Implementation. Updated as each SI is
implemented (status + tests, per the Phase 02 convention).

## Planning pipeline (complete)

| Stage | Skill | Artifact | Status |
|-------|-------|----------|--------|
| Research | `research` | `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01…TD-08) | ✅ done |
| Context | `plan-context` | `context.md` | ✅ done |
| Validate | `plan-validate` | `validation.md` — **status: clean** (6 first-pass issues resolved) | ✅ clean |
| Resolve | `plan-resolve` | `library-refs.md` (bullmq, aws-sdk, fluent-ffmpeg, nanoid) | ✅ done |
| Build | `plan-build` | `phase-03-videos.md` (SIs + Technical Specs + Events/Messages + Dependency Map + Deliverables) | ✅ done |

## Implementation (SI-03.x) — pending

Implementation is the next stage (skill `implement`), conducted SI by SI, running the relevant test
suite at each step and only advancing when the SI's suite is green, then the full DoD (suite +
`npx tsc --noEmit` + `npm run lint`). Work happens on a `feature/*` branch from `dev` (Git Flow).

| SI | Description | Status | Unit | Integration | E2E |
|----|-------------|--------|------|-------------|-----|
| SI-03.1 | Deps, config namespaces, Compose (MinIO+Redis+worker+FFmpeg) | ✅ done | n/a | n/a | n/a |
| SI-03.2 | Storage module (S3/MinIO service) | ✅ done | ✅ module compile | ✅ 5 vs real MinIO | n/a |
| SI-03.3 | Queue module (BullMQ producer) | ✅ done | ✅ module compile | ✅ vs real Redis | n/a |
| SI-03.4 | Video entity + migration + VideosModule | ✅ done | ✅ module compile | ✅ entity vs real DB | n/a |
| SI-03.5 | Create draft + initiate multipart | ✅ done | ✅ service | ✅ svc vs DB+MinIO | ✅ POST /videos |
| SI-03.6 | Presign upload part URLs | ✅ done | ✅ service | ✅ svc vs MinIO | ✅ part-urls |
| SI-03.7 | Complete upload + enqueue processing | ✅ done | ✅ service | ✅ svc vs MinIO+Redis | ✅ complete/abort |
| SI-03.8 | Video worker: process + metadata + thumbnail | ✅ done | ✅ module compile | ✅ metadata + processor vs FFmpeg/MinIO/Redis/DB | n/a |
| SI-03.9 | Get/list videos (status polling) | ✅ done | ✅ service | n/a | ✅ get + list |
| SI-03.10 | Streaming (206) + download + thumbnail | ✅ done | n/a | n/a | ✅ stream/download/thumbnail |
| SI-03.11 | Wire VideosModule into AppModule + OpenAPI | ✅ done | ✅ app.module compile | ✅ openapi export | n/a |
| SI-03.12 | Migration runner integration test (videos) | ✅ done | n/a | ✅ apply + revert videos | n/a |

## Definition of Done (satisfied at close)

- [x] Full test suite green — **190** unit+integration + **73** e2e passing
      (`docker compose exec nestjs-api npm test -- --runInBand` + `npm run test:e2e`)
- [x] `npx tsc --noEmit` exits with code 0
- [x] `npm run lint` passes (see lint-resolution note below)
- [x] `CLAUDE.md` updated with the videos section (both root and `nestjs-project/`), consistent
      with the code
- [x] Git Flow respected — implemented on `feature/phase-03-videos` (from `main`, since `dev` lacks
      the Fase 02 code), no direct commits to `main`; per-SI `feat(videos): SI-03.x` commits

### DoD-stage findings (cross-suite regressions surfaced by the full run)

Individual per-SI test runs passed, but the first full-suite run surfaced three issues fixed here:

- **Channel→Video metadata ripple:** the SI-03.4 inverse `@OneToMany` on `Channel` meant every test
  DataSource with `Channel` but not `Video` failed `Entity metadata for Channel#videos not found`.
  Fixed centrally in `create-test-data-source.ts` (auto-adds `Video` when `Channel` is present), so
  the 10 Fase 02 test files need no change.
- **Flaky BullMQ teardown error (root-caused):** the `video-processing` queue's ioredis connection
  rejects a still-pending `init()` with a benign `Connection is closed.` when a module/app is torn
  down before it finishes connecting (compile-then-close module specs, the OpenAPI export). BullMQ
  re-emits it as an unhandled `'error'` that Node escalates to an async `unhandledRejection`, which
  lands on whichever Jest suite is running — flaking an unrelated suite non-deterministically.
  Per-connection handlers (`queue.on('error')` / `waitUntilReady()` before `close()`) could not
  catch it: the emit fires after the queue's relay is torn down, and `AppModule` opens connections
  beyond the single queue. Root fix: a shared Jest setup
  (`src/test/suppress-benign-connection-errors.ts`, wired into both jest configs' `setupFiles`)
  patches `process.emit` to swallow only that exact benign message and forward everything else —
  the one hook jest-circus can't strip (it swaps out `uncaughtException`/`unhandledRejection`
  listeners per test). Verified stable across back-to-back full runs.
- **E2E must run serially:** `test:e2e` (`jest --config test/jest-e2e.json`) previously defaulted to
  parallel workers, so two suites truncated/seeded the shared test DB concurrently → FK violations
  across `users`/`channels`/`videos`/`refresh_tokens`. Pinned `maxWorkers: 1` in `jest-e2e.json` so
  the documented `npm run test:e2e` is serial by construction.
- **cleanAllTables FK order:** now deletes `videos` before `channels` (videos FK-references channels).
- **Lint resolution (chosen with the user):** the ~211 lint errors were overwhelmingly
  `no-unsafe-*`/`unbound-method` in test files (supertest `res.body` + jest mocks are `any`),
  pre-dating and extending beyond Phase 03. Resolved by an ESLint override relaxing those rules for
  `*.spec.ts`/`*.integration-spec.ts`/`*.e2e-spec.ts` (production code stays strict), plus fixing the
  handful of source cases directly (a Fase 02 `as any`, an ffprobe reject-with-Error, a `Function`
  type). `npm run lint` now exits 0. The prior "pin the eslint version / separate cleanup task"
  options were superseded by this cleaner, scoped fix.

## Implementation notes / findings

- **Branch base:** the project's `dev` branch is behind `main` — the delivered Fase 01/02 **code**
  (auth, users, channels, mail, migrations) lives on `main`, while `dev` only carries planning/skill
  updates. Since Fase 03 depends on the Fase 02 code, `feature/phase-03-videos` was rebased onto
  `main` (never committing to `main` directly). This is the only buildable base for the phase.
- **SI-03.1 validated:** `npx tsc --noEmit` exits **0**; the SI-03.1 files
  (`storage.config.ts`, `queue.config.ts`, `env.validation.ts`, `app.module.ts`) lint **clean**.
- **Pre-existing lint debt:** a full `npm run lint` reports ~150 errors, all in **Fase 02 test files**
  (`test/auth.e2e-spec.ts`, `*.service.spec.ts`, `*.integration-spec.ts`, `create-test-data-source.ts`)
  — `@typescript-eslint/no-unsafe-*` on `res.body` accesses — surfaced by fresher `@typescript-eslint`
  versions from a clean install. These pre-date Fase 03 and are **out of scope** per the CLAUDE.md
  scope-limits rule; the final Definition of Done for the phase will need this baseline addressed
  (env pin or a separate lint-cleanup task) independently of the video feature.

### Implementation session (SI-03.2 onward)

- **Environment bring-up:** full stack up via `docker compose up -d --build` — `db`, `mailpit`,
  `minio`, `redis`, `nestjs-api`, `video-worker` all healthy. FFmpeg/ffprobe 5.1.9 confirmed in the
  worker image. Phase 02 migrations applied. `.env` is gitignored and absent on a fresh checkout —
  recreated from `.env.example` (MAIL_FROM omitted to fall back to the shell-safe code default).
- **Native bindings:** `node_modules` had been installed on the Windows host, so Linux-only optional
  native bindings were missing (`@css-inline/css-inline-linux-x64-gnu` via the mailer adapter, the
  `@unrs/resolver` binding). Fixed with an in-container `npm install` (package-lock unchanged —
  platform variants only).
- **Baseline stabilization** (Phase-02 files, needed for a green suite before implementing videos):
  - `env.validation.integration-spec.ts` — SI-03.1 made `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`
    Joi-`required`, so the schema spec's minimal env now needs them; added to its `requiredEnv`.
  - `migrations.integration-spec.ts` — the run is order-fragile: a `synchronize:true` suite creates
    `verification_tokens_type_enum` before the migration test's `runMigrations`, and `DROP TABLE`
    does not drop the standalone enum. `beforeAll` now also drops the enum type so `CREATE TYPE`
    runs against a clean schema regardless of file order.
  - jest configs (`package.json`, `test/jest-e2e.json`) — enabled ts-jest `isolatedModules` (tsconfig
    already sets it) and raised `testTimeout` to 30s: the first integration suite's `beforeAll` (cold
    module + DB/MinIO connect over the slow Docker mount) exceeded the default 5s hook timeout.
  - `compose.yaml` — mapped the `db` host port to `5433` (internal still `db:5432`) to avoid colliding
    with another local Postgres already bound to host `5432`.
  - Result: full suite green — **150 unit+integration** + **52 e2e** passing.
- **context7 unavailable:** the context7 MCP server is not connected this session. Per CLAUDE.md's
  fallback, library APIs are verified against `library-refs.md` (distilled from official docs) and the
  installed versions (`@aws-sdk/client-s3` 3.1081.0, `@aws-sdk/s3-request-presigner` 3.1081.0,
  `bullmq` 5.79.3, `@nestjs/bullmq` 11.0.4, `fluent-ffmpeg` 2.1.3, `nanoid` 3.3.11 — CJS, as pinned).
- **SI-03.2:** `StorageService` over `@aws-sdk/client-s3` (path-style MinIO) — ensureBucket,
  multipart initiate/presign/complete/abort, ranged read, head, put, presign-get, delete-prefix.
  Integration spec exercises real MinIO (5 tests green); module compile spec green.
- **Streaming visibility (SI-03.10) — security note:** an automated commit review flagged
  `loadReadyVideo` as a possible IDOR/visibility bypass. Assessed as the contracted design, not a
  vulnerability: stream/download/thumbnail serve only `ready` videos, and every `ready` video is
  intentionally public ("anonymous users watch freely"; Authorization Matrix marks these public).
  Non-`ready` videos are never served — they return `409 VIDEO_NOT_READY`, which is the plan's
  explicit contract (Error Catalog + API Contract + the SI-03.10 e2e asserts it). No private content
  is exposed; `public_id`s are non-enumerable nanoids. No code change (would contradict the AC).
- **SI-03.8 (worker):** `VideoProcessor` (@Processor) + `VideoMetadataService` (fluent-ffmpeg) +
  standalone `WorkerModule`/`worker.ts`; the `video-worker` Compose service runs
  `npm run start:worker:dev` and consumes the queue (verified booting + gracefully skipping a
  job whose video was removed). ffprobe/thumbnail read the source over a presigned GET URL (no
  full download). **FFmpeg in `Dockerfile.dev`:** the worker's integration tests exercise ffprobe
  + thumbnailing in-process, and `npm test` runs in the `nestjs-api` container — so ffmpeg was
  added to the dev/test image. Runtime separation is intact: only the `video-worker` service runs
  FFmpeg for real; the API HTTP process never does. `WorkerModule` registers the full
  Video→Channel→User entity graph explicitly (no `autoLoadEntities`, since it does not import the
  domain modules).
