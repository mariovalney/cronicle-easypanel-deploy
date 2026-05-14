# Cronicle Easypanel Deploy Plugin

A [Cronicle Edge](https://github.com/cronicle-edge/cronicle-edge) plugin that creates an ephemeral service in [Easypanel](https://easypanel.io), builds and runs a container from a GitHub repository, monitors the job execution, and destroys the service upon completion.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Parameters](#parameters)
- [Job Protocol](#job-protocol)
- [Environment Variables](#environment-variables)
- [How It Works](#how-it-works)

---

## Overview

The **Easypanel Deploy** plugin allows Cronicle to run containerized jobs without managing persistent infrastructure. For each job execution, the plugin:

1. Creates an app service in Easypanel from a GitHub repository (Dockerfile build)
2. Waits for the container to start
3. Streams logs from the container via Loki
4. Reads the job result from the container's stdout
5. Destroys the service when the job finishes

This pattern is useful for running batch jobs, data pipelines, or any workload that should run in an isolated container and report back a success or failure to Cronicle.

---

## Prerequisites

- **Easypanel** with **Advanced Logs** enabled (required for reading container logs via Loki)
- A GitHub repository containing a `Dockerfile` that runs your job
- An Easypanel API token

---

## Installation

### Docker Image

The repository includes a `Dockerfile` that extends `cronicle/edge:latest` with the plugin already bundled:

```dockerfile
FROM cronicle/edge:latest

COPY conf/easypanel-plugin.json /opt/cronicle/conf/easypanel-plugin.json
COPY plugins /opt/cronicle/plugins
RUN chmod +x /opt/cronicle/plugins/easypanel-deploy.js

CMD ["manager"]
```

### Registering the Plugin

**Option A — Command line (recommended):**

Run this command inside the Cronicle container after startup:

```bash
/opt/cronicle/bin/control.sh import /opt/cronicle/conf/easypanel-plugin.json
```

**Option B — Web UI import:**

1. Go to the Cronicle web UI → **Schedule** tab
2. Click **Import** (top-right corner)
3. Select the file `conf/easypanel-plugin.json`

**Option C — Manual via Web UI:**

1. Go to **Admin → Plugins → Add Plugin**
2. Set **Name** to `Easypanel Deploy`
3. Set **Command** to `/opt/cronicle/plugins/easypanel-deploy.js`
4. Add the parameters listed in the [Parameters](#parameters) section below

---

## Parameters

These parameters are configured per-event in the Cronicle web UI when creating a scheduled job using this plugin.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `easypanel_url` | text | Yes | — | Base URL of your Easypanel instance, without trailing slash. Example: `https://panel.example.com` |
| `easypanel_token` | password | * | — | Easypanel API token. Can be left empty if the `EASYPANEL_TOKEN` environment variable is set on the Cronicle container |
| `project_name` | text | Yes | — | Easypanel project name. Only lowercase letters, numbers, hyphens and underscores are allowed |
| `service_name` | text | Yes | — | Base name for the ephemeral service |
| `service_name_as_prefix` | checkbox | No | `true` | When checked, the final service name is `{service_name}-{job_id}`, guaranteeing uniqueness across concurrent runs. When unchecked, the exact name is used |
| `github_owner` | text | Yes | — | GitHub user or organization that owns the repository |
| `github_repo` | text | Yes | — | Repository name (without the owner prefix) |
| `github_branch` | text | Yes | `main` | Branch to build from |
| `github_build_path` | text | No | `/` | Path inside the repository where the Dockerfile is located |
| `dockerfile` | text | No | `Dockerfile` | Dockerfile path, relative to Build Path |
| `run_command` | text | No | — | Runtime command to override the Dockerfile `CMD`. Corresponds to **Advanced → Command** in Easypanel. Leave empty to use the image default |
| `env_vars` | textarea | No | `{}` | Environment variables passed to the container, as a JSON object. Example: `{"NODE_ENV": "production", "PORT": "3000"}` |

> **\* Token via environment variable:** Instead of setting the token on every event, you can add `EASYPANEL_TOKEN` to the `job_env` section of your Cronicle `config.json`. The plugin reads the parameter first; if empty, it falls back to `process.env.EASYPANEL_TOKEN`.

---

## Job Protocol

The script running inside the container must follow the [Cronicle Plugin Protocol](https://github.com/jhuckaby/Cronicle/blob/master/docs/Plugins.md) — writing JSON lines to `stdout`.

**Reporting progress** (optional):

```json
{"progress": 0.25}
{"progress": 0.75}
```

**Reporting success:**

```json
{"complete": 1, "code": 0, "label": "Job completed successfully"}
```

**Reporting failure:**

```json
{"complete": 1, "code": 1, "description": "Something went wrong"}
```

Rules:

- The container process **must exit with code 0**, regardless of the job result. If the process exits with a non-zero code, Easypanel will restart the container.
- The last line containing `"complete": 1` determines what is reported back to Cronicle.
- If no `complete` line is found in the container logs, the plugin reports a failure.
- Any free-form text printed to stdout also appears in the Easypanel service logs.

**Example job script (Node.js):**

```javascript
#!/usr/bin/env node
'use strict';

async function run() {
  // ... your job logic ...

  process.stdout.write(JSON.stringify({ progress: 0.5 }) + '\n');

  // ... more work ...

  process.stdout.write(JSON.stringify({ complete: 1, code: 0, label: 'Done' }) + '\n');
}

run().catch(err => {
  process.stdout.write(JSON.stringify({ complete: 1, code: 1, description: err.message }) + '\n');
}).finally(() => process.exit(0));
```

---

## Environment Variables

The plugin reads the following environment variables from the Cronicle container:

| Variable | Description |
|---|---|
| `EASYPANEL_TOKEN` | Easypanel API token. Used as fallback when the `easypanel_token` parameter is not set on the event |

To set this globally for all jobs, add it to the `job_env` section of your Cronicle `config.json`:

```json
"job_env": {
  "EASYPANEL_TOKEN": "your-api-token-here"
}
```

---

## How It Works

1. **Read input** — Cronicle passes job parameters as JSON via `stdin`.
2. **Validate** — Required parameters are checked; the plugin exits with failure if any are missing.
3. **Resolve service name** — The service name is built from `service_name` plus the job ID (if `service_name_as_prefix` is checked), then sanitized to match Easypanel naming rules.
4. **Check for conflicts** — If a service with the same name already exists, the plugin fails immediately to avoid overwriting running workloads.
5. **Create service** — The plugin calls the Easypanel tRPC API to create an app service from the specified GitHub repository.
6. **Wait for deploy** — Polls the Easypanel actions API until the build and startup are complete. Reports incremental progress to Cronicle during this phase.
7. **Wait for job result** — Polls the Loki log API until a line with `"complete": 1` appears in the container's stdout. Progress lines (`"progress": N`) are forwarded to Cronicle in real time.
8. **Destroy service** — The ephemeral service is always destroyed after the job finishes, regardless of success or failure.
9. **Report result** — The plugin reports success or failure to Cronicle based on the `code` field in the job's completion line.

Note: Advanced Logs must be enabled in Easypanel for step 7 to work. Without it, the Loki endpoint returns HTTP 500 and the plugin exits with an error.
