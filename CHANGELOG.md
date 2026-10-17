# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-10-17

### Security

- Secrets no longer need to go through job parameters, which Cronicle writes in plain text to its transaction log. The plugin reads its own configuration from `EASYPANEL_DEPLOY_URL` and `EASYPANEL_DEPLOY_TOKEN` (container env or plugin Secret) when `easypanel_url` / `easypanel_token` are empty, and forwards the event Secret variables to the service, except `EASYPANEL_DEPLOY_*`
- A warning is logged while `easypanel_token` is still set as a parameter
- The job fails before creating the service when an event Secret variable is also set in `env_vars` or is missing from the job environment

### Docs

- New Secrets section in README with the migration steps

## [2.1.0] - 2026-06-10

### Added

- `mounts` parameter: volumes/mounts passed to the service as a JSON array; invalid JSON or a non-array value fails the job before the service is created

## [2.0.0] - 2026-06-06

> **Breaking change:** requires Easypanel 2.31.0 or later.

### Changed

- Migrated all Easypanel API calls from tRPC (`/api/trpc/*`, GET + encoded query string) to oRPC (`/api/rpc/*`, POST + `{ json: { ... } }` body) to support Easypanel 2.31.0+
- Updated response unwrapping from `result.data.json` to `json`
- Updated error message extraction to handle the new oRPC error format (`error.json.message` with fallback to `error.message`)

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

[2.1.1]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/2.1.0...2.1.1
[2.1.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/compare/1.0.0...v2.0.0
[1.0.0]: https://github.com/mariovalney/cronicle-easypanel-deploy/releases/tag/1.0.0
