# Runbook: logs, request ids, Sentry and health

Spec: `docs/parity/m10.md` ("Observability", package B). Code: `lib/log/`, `lib/observability/`, `lib/health/`, `lib/worker-health/`, `proxy.ts`, `instrumentation.ts`.

## Log shape

App, worker and migrations write **one JSON object per line on stdout** through pino (`lib/log`). There are no transports and no files; Docker collects stdout (`json-file`, 10 MB × 5 per container).

```json
{"level":"error","time":"2026-10-14T09:12:03.120Z","service":"worker","version":"0.6.0","component":"jobs","jobId":"1842","queue":"meetsum","jobName":"meeting.summarize","workspaceId":"ws_…","err":{"type":"LlmError","message":"…","stack":"…"},"msg":"AI title not applied"}
```

| Field | Meaning |
|---|---|
| `level` | `trace` `debug` `info` `warn` `error` `fatal` |
| `time` | ISO 8601 UTC |
| `service` | `app` (Next.js), `worker` (`worker/index.ts`) or `migrate` (`scripts/migrate.ts`) |
| `version` | `package.json` version (never `npm_package_version`) |
| `component` | the module that logged (`bot`, `integrations`, `jobs`, `search`, `auth`, `rate-limit`, …) |
| `reqId`, `route`, `method`, `principal`, `workspaceId` | per request (see below) |
| `jobId`, `queue`, `jobName`, `workspaceId` | per worker job |
| `err` | a logged error: type, redacted message, redacted stack |

`LOG_LEVEL` sets the level (default `info` in production, `debug` otherwise). For a readable local view, pipe through pino-pretty without installing it in the project: `npm run dev | npx pino-pretty`.

Server code must not use `console.*`: ESLint's `no-console` is an error for `lib/`, `app/`, `worker/`, `instrumentation.ts` and `proxy.ts`. Use:

```ts
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "my-module" })

log.warn({ meetingId, err: error }, "thing failed")
```

## Request ids

- `proxy.ts` runs on pages and `/api/*`. It keeps an incoming `x-request-id` only if it matches `^[A-Za-z0-9._-]{8,64}$`. Anything else (newlines, control characters, wrong length) is replaced with a fresh UUID, so a client can't inject log lines. The id is forwarded to the route and echoed on the response.
- `withAuthz`, `withSession` and `withPublicRoute` run every handler inside `withLogContext({ reqId, route, method, principal, workspaceId? })`. `route` is the path with ids and tokens replaced by `[id]` (for example `/api/share/[id]/verify`); query strings are never logged.
- Worker jobs run inside `withLogContext({ jobId, queue, jobName, workspaceId? })` for the `meetsum`, `meetsum-bot` and `meetsum-integrations` queues.

Follow one request across app and worker:

```bash
docker compose -f docker-compose.prod.yml logs app worker --since 1h | grep '"reqId":"<id from the response header>"'
# then follow the job it enqueued:
docker compose -f docker-compose.prod.yml logs worker --since 1h | grep '"jobId":"<id>"'
```

## Redaction

Two layers, both in `lib/log`:

1. **pino `redact.paths`** (censor `[redacted]`): `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, and `*.token`, `*.accessToken`, `*.refreshToken`, `*.idToken`, `*.password`, `*.passwordHash`, `*.secret`, `*.clientSecret`, `*.apiKey`, `*.passcode`, `*.code`, `*.codeVerifier`, `*.authorization`, `*.cookie` (`REDACT_PATHS` in `lib/log/redact.ts`).
2. **Deep scrub** (`formatters.log`, depth 4; `scrubValue` in `lib/log/redact.ts`):
   - keys matching `token|secret|password|passcode|authori[sz]ation|cookie|api[-_]?key|verifier|signature|credential|private[-_]?key`, plus exactly `code` and `otp`, become `[redacted]` at any level (numeric `…Tokens` usage counters are kept);
   - **content keys** (`text`, `transcript`, `segment(s)`, `summary`, `question(s)`, `answer(s)`, `comment(s)`, `prompt(s)`, `messages`, `content`, `body`, `notes`, `html`, `markdown`) become `[omitted]`: transcript, summary, question and comment text are never logged;
   - email addresses inside strings are masked (`dana@example.com` → `d***@example.com`);
   - URL query strings and fragments are stripped;
   - error messages and stacks go through the bot, integration and ASR redactors (`redactBotText`, `redactIntegrationError`, `redactAsrErrorMessage`).

   Message strings (the `msg` field) are scrubbed in a `logMethod` hook, because they never reach the formatter.

`tests/log-redaction.test.ts` seeds a token, a password, an email, an OAuth code and a Hebrew transcript sentence, and checks that none of them reach the output.

**Adding a key:** a new secret field name that doesn't match the pattern goes into `SECRET_KEY` (or `REDACT_PATHS` for a fixed path); a new user-content field goes into `CONTENT_KEY`. Add the canary to `tests/log-redaction.test.ts` in the same change.

## Sentry or GlitchTip (optional)

Off unless `SENTRY_DSN` is set. Then `instrumentation.ts` (app) and `worker/index.ts` load `lib/observability/sentry.ts`, which imports `@sentry/node`. Without a DSN neither module is ever imported (`tests/sentry-off-by-default.test.ts`). There is no browser SDK.

| Variable | Effect |
|---|---|
| `SENTRY_DSN` | Enables reporting. A **GlitchTip** DSN works the same way (self-hosted, Sentry-compatible). |
| `SENTRY_ENVIRONMENT` | `environment` tag (default: `NODE_ENV`) |
| `SENTRY_TRACES_SAMPLE_RATE` | 0–1, default 0 (no tracing) |
| `MEETSUM_GIT_SHA` | Build arg; the release is `meetsum@<version>+<sha12>` |

`sendDefaultPii` is false. `beforeSend` drops request cookies, headers, body and query string, `user.email`, `user.ip_address` and stack-frame variables, and runs the logger's `scrub()` on the message, exception values, `extra`, `contexts` and breadcrumbs. Breadcrumb URLs lose their query (`tests/sentry-scrub.test.ts`). `onRequestError` in `instrumentation.ts` always logs the error through pino and forwards it to Sentry when enabled. Failed worker jobs are reported too.

To enable: put the DSN in `.env.local` and redeploy (or restart app and worker). To disable: remove it and restart.

OpenTelemetry export is not wired; it's a follow-up in the audit.

## Health endpoints

See `deploy.md` → "Readiness endpoints" for the full table. In short:

- `GET /api/health/live`: process is up; no dependency calls.
- `GET /api/health/ready`: database, Redis, storage and migrations; 503 when any fails.
- worker `GET /live` and `GET /ready` on `MEETSUM_WORKER_HEALTH_PORT` (default 3101, bound to `MEETSUM_WORKER_HEALTH_HOST`, default `0.0.0.0` inside the container, never published).

From the host:

```bash
docker compose -f docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready
docker compose -f docker-compose.prod.yml exec -T worker sh -c 'wget -qO- http://127.0.0.1:${MEETSUM_WORKER_HEALTH_PORT:-3101}/ready'
```

## Rate limiter on Redis

`MEETSUM_RATE_LIMIT_BACKEND=memory|redis` (default `redis` when `REDIS_URL` is set). Keys are `rl:<preset>:<sha256(key)>`; raw IPs and user ids never reach Redis. When Redis is down or slower than 500 ms, the cost and abuse presets (`share-verify`, `ask`, `llmOnDemand`, `auth` = OAuth start, `exports`, `search`) answer 429, and everything else falls back to the per-instance memory limiter. A `warn` line from component `rate-limit` is logged at most once a minute while that lasts. The health probes always use the in-process limiter.

## Log rotation

Each service in `docker-compose.prod.yml` and `docker-compose.yml` uses:

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "5" }
```

That is at most about 50 MB per container. Ship logs elsewhere (Loki, a GlitchTip log drain, `docker logs` to a file) if you need longer retention.
