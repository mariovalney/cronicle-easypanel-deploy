# Easypanel API Reference

Documentation specific to Easypanel version **2.36.0** (minimum supported by the plugin: **2.33.2**). The API is **REST**: reads via **GET** with a query string, writes via **POST** with a plain JSON body. The oRPC `{"json": {...}}` envelope (`/api/rpc/*`) used up to 2.32.x is gone, in both the request and the response.

---

## Authentication

All requests require the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is generated in the Easypanel dashboard under **Settings → API Tokens**. The token must have access to the target project. A token for project A cannot see actions/services of project B.

---

## Request pattern

Read (GET), fields in the query string:

```
GET /api/inspectAppService?projectName=my-project&serviceName=my-service
Authorization: Bearer <token>
```

Write (POST), plain JSON body:

```
POST /api/destroyAppService
Authorization: Bearer <token>
Content-Type: application/json

{ "projectName": "my-project", "serviceName": "my-service" }
```

> In 2.33.1, numeric query string parameters (`limit`, `range`) were rejected with
> `BAD_REQUEST: "Expected number, received string"`. Fixed in 2.33.2, which is why it is the
> plugin's minimum version.

## Response format

Success (HTTP 200) returns the object directly:

```json
{ "enabled": true, "name": "my-service", "projectName": "my-project", "...": "..." }
```

Lists come as a plain array:

```json
[ { "id": "abc123", "...": "..." } ]
```

Endpoints with no return value (`destroyAppService`, `restartAppService`) respond HTTP 200 with an **empty body**.

Errors return HTTP 4xx/5xx with:

```json
{
  "defined": false,
  "code": "NOT_FOUND",
  "status": 404,
  "message": "Service not found."
}
```

Validation errors include `data.zodErrors`:

```json
{
  "defined": false,
  "code": "BAD_REQUEST",
  "status": 400,
  "message": "Input validation failed",
  "data": { "zodErrors": { "limit": "Expected number, received string" } }
}
```

---

## Services

### Inspect service

Checks whether a service exists and returns its configuration.

- **Endpoint:** `GET /api/inspectAppService?projectName=my-project&serviceName=my-service`

**Response (200):**

```json
{
  "enabled": true,
  "name": "my-service",
  "projectName": "my-project",
  "type": "app",
  "source": { "type": "image", "image": "alpine:latest" },
  "deploy": { "command": null, "replicas": 1, "zeroDowntime": true },
  "env": "",
  "mounts": [],
  "ports": [],
  "deploymentUrl": "http://<host>:3000/api/deploy/<token>"
}
```

If the service does not exist, it returns HTTP 404 (`NOT_FOUND`).

---

### Create service

Creates a new app service from a GitHub repository, built from a Dockerfile. Creation starts the deploy automatically.

- **Endpoint:** `POST /api/createAppService`

**Body:**

```json
{
  "projectName": "my-project",
  "serviceName": "my-service",
  "source": {
    "type": "github",
    "owner": "my-org",
    "repo": "my-repo",
    "ref": "main",
    "path": "/",
    "autoDeploy": false
  },
  "build": {
    "type": "dockerfile",
    "file": "Dockerfile"
  },
  "env": "NODE_ENV=production\nPORT=3000",
  "mounts": [],
  "deploy": {
    "command": null
  }
}
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `projectName` | string | Existing project in Easypanel (required) |
| `serviceName` | string | Service name, only `[a-z0-9-_]` (required) |
| `source.type` | string | `"github"` |
| `source.owner` | string | GitHub user or organization |
| `source.repo` | string | Repository name |
| `source.ref` | string | Branch or tag |
| `source.path` | string | Build subdirectory inside the repo (e.g. `"/"`) |
| `source.autoDeploy` | boolean | Automatic trigger on push. Use `false` |
| `build.type` | string | `"dockerfile"` |
| `build.file` | string | Path to the Dockerfile inside the repo |
| `env` | string | Environment variables in the format `KEY=VALUE\nKEY2=VALUE2` |
| `mounts` | array | Volume/bind mounts |
| `deploy.command` | string\|null | Overrides the Dockerfile `CMD`; `null` uses the default |

**Response:** HTTP 200 with the created service object (same format as `inspectAppService`).

---

### Destroy service

Permanently removes a service and its data.

- **Endpoint:** `POST /api/destroyAppService`

**Body:**

```json
{ "projectName": "my-project", "serviceName": "my-service" }
```

**Response:** HTTP 200 with an empty body.

---

## Actions (deploy monitoring)

Easypanel records each operation as an "action". Use `listActions` to find out whether a deploy has finished.

### List actions

- **Endpoint:** `GET /api/listActions?projectName=my-project&serviceName=my-service&type=deployment&limit=1`

**Query params (all optional):**

| Field | Type | Description |
|---|---|---|
| `projectName` | string | Filter by project |
| `serviceName` | string | Filter by service |
| `type` | string | `build`, `deployment`, `script`, `start`, `stop`, `destroy`, `backup`, `volumeBackup`, `settings`, `wordpress`, `auth`, `env` |
| `limit` | number | Number of results (default: 8) |

**Response (200):**

```json
[
  {
    "id": "abc123",
    "projectName": "my-project",
    "serviceName": "my-service",
    "type": "deployment",
    "status": "done",
    "description": "Deploy service",
    "userEmail": "user@example.com",
    "createdAt": "2026-08-19 13:59:21",
    "updatedAt": "2026-08-19 13:59:21"
  }
]
```

**Values of the `status` field:**

| Status | Meaning |
|---|---|
| `done` / `success` / `completed` | Completed successfully |
| `error` / `failed` / `cancelled` | Failed or was cancelled |
| Anything else | In progress, keep polling |

**Polling strategy:**

```js
while (true) {
  const actions = await get('/api/listActions', {
    projectName, serviceName, type: 'deployment', limit: 1,
  });
  const action = actions?.[0];
  if (!action) { await sleep(5000); continue; }
  if (['done', 'success', 'completed'].includes(action.status)) break;
  if (['error', 'failed', 'cancelled'].includes(action.status)) throw new Error('Deploy failed');
  await sleep(5000);
}
```

> **Warning:** the token must have access to the project. If `listActions` returns an empty array even after the deploy, check that the token belongs to a user with permission on the project.

---

## Logs (Loki)

> **Requirement:** **Advanced Logs** must be enabled in Easypanel (it uses Loki internally). Without it, 2.36.0 responds HTTP 400 with `"message": "fetch failed"` (2.32.x responded HTTP 500).

> **Success format confirmed on 2.36.0** (2026-09-25, with
> Advanced Logs enabled): same format as 2.32.2, just without the `{json}` envelope.
>
> **Still to be verified on 2.36.0: which window the API returns when there are more than `limit`
> lines from `start`.** On 2.32.2 it was the OLDEST ones (verified in production, see
> "Truncation" below). In the 2.36.0 test, `values` came from newest to
> oldest, which is Loki's default order with `direction=backward`, and in that direction Loki
> returns the NEWEST lines. If that is the case, the plugin's `start`-based pagination still
> finds the `{"complete"}`, but it may skip intermediate lines of a burst of more than
> 1000 lines between two queries.

### Query service logs

- **Endpoint:** `GET /api/queryServiceLogs?projectName=my-project&serviceName=my-service&limit=1000&stream=stdout&start=1780776369782000000`

**Query params:**

| Field | Type | Description |
|---|---|---|
| `projectName` | string | Project name (required) |
| `serviceName` | string | Service name (required) |
| `limit` | number | Maximum number of lines in the **whole** response (summing all groups). Default 100, **hard cap of 1000** |
| `stream` | string | `"stdout"` or `"stderr"` |
| `start` | string | Timestamp in **nanoseconds**: start of the search window, **inclusive** |
| `end` | string | End of the window (not used by the plugin) |
| `search` | string | Text search filter (not used by the plugin) |
| `levels` | array | Log levels (not used by the plugin) |

**Convert a timestamp to nanoseconds:**

```js
const startNs = String(BigInt(Date.now()) * 1_000_000n);
```

> `Date.now() * 1_000_000` exceeds `Number.MAX_SAFE_INTEGER` and loses precision (~±128ns).
> Irrelevant for a window cutoff, but use `BigInt` if the value is compared
> exactly.

> **Warning:** the Loki stream is indexed by `swarm_service_name`. Services recreated
> with the same name accumulate the logs of **all** previous runs in the same stream.
> Only `start` separates one run from another.

**Response (200):**

```json
{
  "entries": [
    {
      "stream": {
        "container_name": "/project_service.1.xyz",
        "detected_level": "unknown",
        "stream": "stdout",
        "swarm_service_name": "project_service"
      },
      "values": [
        ["1780776369782668202", "{\"complete\": 1, \"code\": 0, \"label\": \"Success\"}"],
        ["1780776369782662734", "{\"progress\": 0.9}"],
        ["1780776369782653029", "free-form log text"]
      ]
    }
  ]
}
```

**Structure of `entries`:**

- `entries` is an array of groups (Loki groups by `detected_level` and by container)
- Each group has `values`: an array of `[timestamp_ns_string, text_line]`
- The `{"complete": 1, ...}` can be in any group, so iterate over all of them
- The order **within** the response is not guaranteed (on 2.36.0 it came from newest to oldest): sort by timestamp before processing

**Truncation: read before polling:**

The API returns the **OLDEST** `limit` lines from `start` and discards the newer
excess. This was verified in production (2.32.2): queries with `limit: 100` and
`limit: 1000` start at exactly the same timestamp, and the larger limit only extends
forward in time.

Practical consequence: **a fixed `start` with polling never reaches a log that grows beyond
`limit` lines.** The newest lines, including the `{"complete": 1, ...}` that
ends the job, stay permanently outside the window. This was exactly the cause of an
Easypanel Deploy plugin job hanging forever at 78%: the container wrote 102
lines and the `complete`, at index 101, never made it into a window of 100.

**Correct pagination:** advance `start` to the timestamp of the last line already processed on
each query, and repeat immediately while the response comes back with `limit` lines
(a sign that there is still more to read). Since `start` is inclusive, the boundary line comes back
repeated, so filter by `timestamp > last_seen`.

```js
let lastSeen = startNs;
while (true) {
  const { entries } = await get('/api/queryServiceLogs', { projectName, serviceName, start: lastSeen, limit: 1000 });
  const values = entries.flatMap(e => e.values).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const fresh = values.filter(([ts]) => ts > lastSeen);
  for (const [ts, line] of fresh) { lastSeen = ts; /* process */ }
  if (values.length < 1000) break;  // window not full: nothing pending
  if (fresh.length === 0) break;    // guard against infinite loop
}
```

---

## Endpoint summary

| Operation | Endpoint | Method | Equivalent oRPC endpoint (≤ 2.32.x) |
|---|---|---|---|
| Check service | `/api/inspectAppService` | GET | `/api/rpc/services/app/inspectService` |
| Create service | `/api/createAppService` | POST | `/api/rpc/services/app/createService` |
| Destroy service | `/api/destroyAppService` | POST | `/api/rpc/services/app/destroyService` |
| Monitor deploy | `/api/listActions` | GET | `/api/rpc/actions/listActions` |
| Fetch logs (Loki) | `/api/queryServiceLogs` | GET | `/api/rpc/logs/queryServiceLogs` |
