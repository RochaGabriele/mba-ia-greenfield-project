# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Create the env file (first time only) — required for the app/worker to boot
cp .env.example .env

# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit + integration (serial: maxWorkers 1)
npm run test:watch                       # Unit + integration in watch mode
npm run test:cov                         # Coverage report (serial: maxWorkers 1)
npm run test:e2e                         # End-to-end tests (serial: maxWorkers 1)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database, so they run **serially**. Serialization is pinned via `maxWorkers: 1` in both jest configs (see "Jest Configuration" below), so no `--runInBand` flag is needed:

```bash
docker compose exec nestjs-api npm test           # serial by default (maxWorkers: 1)
docker compose exec nestjs-api npm run test:e2e   # serial by default (maxWorkers: 1)
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently — which is exactly why the config pins `maxWorkers: 1`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ".../suppress-benign-connection-errors.ts"]` — the first loads `.env` inside the Jest process (without it `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or the host's `localhost`, breaking container-to-container DNS). The second (`src/test/suppress-benign-connection-errors.ts`) patches `process.emit` to swallow BullMQ's benign `Connection is closed.` teardown error — an async unhandled rejection that otherwise lands on, and flakes, an unrelated later suite. Keep both entries in **both** jest configs.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- **Both** jest configs set `maxWorkers: 1` — the `package.json` jest block (for `npm test` / `test:cov` / `test:watch`) and `test/jest-e2e.json` (for `test:e2e`). All of these suites share one test DB, so they **must** run serially; without it, parallel workers truncate/seed shared tables concurrently and cause FK violations. This is why the commands above need no `--runInBand` flag.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Video Module & Processing Pipeline (Phase 03)

Large-file (up to 10GB) video upload without routing bytes through the API, background processing
(duration/metadata + thumbnail) via a queue and a dedicated FFmpeg worker, and HTTP-range streaming.

### Module (`src/videos/`)

- `entities/video.entity.ts` — `Video` (`videos` table): `status` enum
  `draft | uploading | processing | ready | error`, unique 11-char `public_id` (nanoid), FK
  `channel_id → channels.id`, `storage_key`, `thumbnail_key`, `upload_id`, `size_bytes` (bigint),
  `duration_seconds`, `metadata` (jsonb), `failure_reason`. Migration `CreateVideos`.
- `videos.service.ts` — `VideosService`: `createDraft`, `presignParts`, `completeUpload`,
  `abortUpload`, `getByPublicId`, `listOwn`, `getStreamData`/`getDownloadData`/`getThumbnailData`.
- `videos.controller.ts` — `VideosController` (`@Controller('videos')`).
- `video-queue.service.ts` — `VideoQueueService.enqueueProcessing(videoId)` (BullMQ producer).
- `video-processor.ts` — `VideoProcessor` (`@Processor`, `WorkerHost`) — runs **only in the worker**.
- `video-metadata.service.ts` — `VideoMetadataService` (fluent-ffmpeg `ffprobe` + `.screenshots`).
- `video-processing.constants.ts`, `dto/*`.

### Endpoints (all under `/videos`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/videos` | Bearer | Create draft + initiate multipart (413 `UPLOAD_TOO_LARGE` over 10GB) |
| POST | `/videos/:publicId/upload/part-urls` | Bearer, owner | Presigned PUT URLs per part; `draft→uploading` |
| POST | `/videos/:publicId/upload/complete` | Bearer, owner | Finalize + `processing` + enqueue (200) |
| POST | `/videos/:publicId/upload/abort` | Bearer, owner | Abort + remove draft (204) |
| GET | `/videos` | Bearer | List caller's channel videos, newest first, paginated |
| GET | `/videos/:publicId` | Public (ready) / owner | Drafts hidden from strangers (404) |
| GET | `/videos/:publicId/stream` | Public | Range→`206`, no Range→`200`, 416 invalid, 409 not-ready |
| GET | `/videos/:publicId/download` | Public | `ready` only, `Content-Disposition: attachment` |
| GET | `/videos/:publicId/thumbnail` | Public | JPEG, 404 until generated |

Write endpoints use the global `JwtAuthGuard`; public reads opt out with `@Public()`. The single-get
uses `OptionalJwtAuthGuard` (populates the user when a token is present so the owner sees drafts).
Streaming endpoints are `@SkipThrottle()` (playback issues many range requests).

### Storage, queue, worker (Docker)

- **Object storage** — `StorageService` (`src/storage/`) over `@aws-sdk/client-s3` against **MinIO**
  (`forcePathStyle: true`). Single bucket `streamtube-videos`; keys `videos/{id}/original/{file}` and
  `videos/{id}/thumbnail.jpg`. Presigned multipart upload (bytes go client→MinIO, never through the
  API); ranged `GetObject` for streaming. Config: `src/config/storage.config.ts` (`STORAGE_*`).
- **Queue** — `QueueModule` (`src/queue/`): BullMQ over **Redis**, queue `video-processing`; job
  `process` payload `{ videoId }`, 3 attempts + exponential backoff, `removeOnFail: false`. Producer
  runs on `completeUpload`. Config: `src/config/queue.config.ts` (`REDIS_*`, `VIDEO_PROCESSING_*`).
- **Worker** — `src/worker.ts` boots `WorkerModule` (`src/worker.module.ts`) as a standalone Nest
  application context (no HTTP), hosting `VideoProcessor`. The `video-worker` Compose service runs
  `npm run start:worker:dev`. It reads metadata + thumbnail over a **presigned GET URL** (no full
  download), uploads the thumbnail, and sets `ready`; terminal failure → `error` + `failure_reason`;
  idempotent (no-op if already `ready` or the row is gone).

Compose services: `minio` (9000/9001), `redis` (6379), `video-worker` (FFmpeg), alongside `db`,
`mailpit`, `nestjs-api`. The `db` host port is published as `5433` (internal is still `db:5432`) to
avoid colliding with other local Postgres instances.

**FFmpeg at runtime is only in the `video-worker`** service; the API never invokes it. FFmpeg is also
installed in `Dockerfile.dev` so the worker's integration tests (which exercise ffprobe/thumbnail
in-process) run under `npm test` in the `nestjs-api` container.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
