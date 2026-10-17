# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-10-17

> **Breaking changes:** requires Easypanel 2.33.2 or later, and the API token now comes only from `EASYPANEL_DEPLOY_TOKEN`.

### Changed

- Migrated all Easypanel API calls from oRPC (`/api/rpc/*`, POST + `{ json: { ... } }` body) to the REST API: reads via GET with a query string (`inspectAppService`, `listActions`, `queryServiceLogs`), writes via POST with a plain JSON body (`createAppService`, `destroyAppService`). Validated on 2.36.0
- Error messages now include the API `message` and validation details (`zodErrors`)
- Detects disabled Advanced Logs from the 2.36.0 response (HTTP 400 `fetch failed`), besides the older HTTP 500
- The deploy timeout is now 30 minutes (it shared the 24-hour job timeout); the 24-hour timeout applies only to waiting for the job result

### Removed

- `easypanel_token` parameter. Set `EASYPANEL_DEPLOY_TOKEN` in the Cronicle container env or in the plugin Secret
- Service CPU, memory and network stats (`[PERF]` lines) and the unused `deployService` and `parseJobResult` functions

### Added

- `override` parameter: a JSON object deep-merged over the final `createAppService` payload, overriding any value
- `CRONICLE_JOB_ID` is always injected into the service env with the Cronicle job ID
- Every HTTP request has a timeout (120 seconds, `EASYPANEL_HTTP_TIMEOUT_MS`), so a hung connection no longer hangs the job
- Gives up after 5 minutes when no deploy action appears (`EASYPANEL_DEPLOY_ACTION_TIMEOUT_MS`), instead of waiting the full deploy timeout
- Tolerates up to 5 consecutive failures when querying the deploy action or the logs
- Diagnostic `[DEBUG]` heartbeat line about every minute while waiting for the job result
- Test suite with Node's built-in runner (`node --test`) and a GitHub Actions workflow
- `docs/easypanel-api.md`: Easypanel REST API reference

### Fixed

- Jobs whose container wrote more than 100 lines never finished: the log query used a fixed `start`, and the API returns the oldest lines from it, so the `{"complete": 1}` line stayed out of the window. The window now slides with the last line seen, uses the API cap of 1000 lines and drains bursts above it
- Log lines written right after the container started could be missed: the log time cutoff is now taken before the service is created
- When `createAppService` gets no response but the service was created, the plugin now proceeds instead of destroying it

## [2.1.1] - 2026-10-17

### Security

- Secrets no longer need to go through job parameters, which Cronicle writes in plain text to its transaction log. The plugin reads its own configuration from `EASYPANEL_DEPLOY_URL` and `EASYPANEL_DEPLOY_TOKEN` (container env or plugin Secret) when `easypanel_url` / `easypanel_token` are empty, and forwards the event Secret variables to the service, except `EASYPANEL_DEPLOY_*`
- A warning is logged while `easypanel_token` is still set as a parameter
- The job fails before creating the service when an event Secret variable is also set in `env_vars` or is missing from the job environment

### Docs

- New Secrets section in README with the migration steps

## [2.1.0] - 2026-06-10

### Added

- `mounts` parameter ("Storage (JSON)" in the plugin form): a JSON array of mounts attached to the ephemeral service, such as `[{"hostPath": "/etc/easypanel/volumes/recordings", "mountPath": "/recordings", "type": "bind"}]`. Validated before calling the Easypanel API: invalid JSON or a non-array value fails the job

### Docs

- Documented the `mounts` parameter in README

## [2.0.0] - 2026-06-06

> **Breaking change:** requires Easypanel 2.31.0 or later.

### Changed

- Migrated all Easypanel API calls from tRPC (`/api/trpc/*`, GET + encoded query string) to oRPC (`/api/rpc/*`, POST + `{ json: { ... } }` body) to support Easypanel 2.31.0+
- Updated response unwrapping from `result.data.json` to `json`
- Updated error message extraction to handle the new oRPC error format (`error.json.message` with fallback to `error.message`)

### Added

- Automatic rollback: if `createService` fails after partially creating the service, the partial service is destroyed before the error is reported; if the deploy or the job fails, the service is destroyed too. This prevents the "service already exists" deadlock on retry

### Fixed

- `getServiceStats` was calling a non-existent `rpcQuery` function; corrected to use `rpcMutation`

### Docs

- Added Easypanel 2.31.0+ minimum version requirement to Prerequisites section in README
- Removed outdated tRPC reference from How It Works section in README

## [1.0.0] - 2026-05-14

Initial release.

### Added

- `plugins/easypanel-deploy.js`: Cronicle plugin that creates an ephemeral Easypanel app service from a GitHub repository, monitors the deploy via the actions API, tails container logs via Loki, and destroys the service after the job completes
- `conf/easypanel-plugin.json`: Cronicle plugin definition with all configurable parameters
- `Dockerfile`: extends `cronicle/edge:latest` with the plugin pre-installed
- `examples/hello-world/`: reference implementation of a containerized job following the Cronicle plugin protocol
- `README.md`: full documentation including prerequisites, installation, parameters, job protocol, and flow description

[3.0.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/2.1.1...3.0.0
[2.1.1]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/2.1.0...2.1.1
[2.1.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/1.0.0...v2.0.0
[1.0.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/releases/tag/1.0.0
