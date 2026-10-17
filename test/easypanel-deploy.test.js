'use strict';

/**
 * Tests for the Easypanel Deploy plugin.
 *
 * Runs with Node's built-in runner (no dependencies):
 *     node --test
 *
 * The mock reproduces the behavior of the Easypanel REST API (2.36.0): reads via GET with a
 * query string, writes via POST with a plain JSON body, no oRPC {json:{...}} envelope. The mock
 * only answers each operation on the right method, so a regression to the old format falls
 * into the default 404.
 *
 *   - `queryServiceLogs` returns the `limit` OLDEST lines from `start`, with `values` ordered
 *     newest first (the plugin must sort them before processing)
 *   - `start` is inclusive
 *   - `limit` has a hard cap of 1000; above that the API answers BAD_REQUEST
 *   - there is no direction parameter
 *
 * With a fixed `start` at the job start and a `limit` of 100, a container that wrote 102 lines
 * had its {"complete"} line (index 101) permanently out of the window, and polling never ended.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'easypanel-deploy.js');
const API_LIMIT_CAP = 1000;

const NOT_FOUND = { defined: false, code: 'NOT_FOUND', status: 404, message: 'Service not found.' };

/**
 * Identifies the called operation as "METHOD operation" (e.g. "GET inspectAppService") and
 * extracts its fields: from the query string on GET, from the JSON body on POST.
 */
function parseCall(req, raw) {
  const url = new URL(req.url, 'http://mock');
  const op = `${req.method} ${url.pathname.replace(/^\/api\//, '')}`;
  const fields = req.method === 'GET'
    ? Object.fromEntries(url.searchParams)
    : JSON.parse(raw || '{}');
  return { op, fields };
}

/**
 * Builds a synthetic container log following the Cronicle protocol.
 * {"progress": 0.9} sits at `numLines - 3` and {"complete"} on the last line, so both fall past
 * line 100 whenever numLines > 102.
 */
function containerLog(numLines, complete = '{"complete": 1, "code": 0, "label": "ok"}') {
  const lines = ['---------------- testjob ----------------', '{"progress": 0.1}'];
  while (lines.length < numLines - 2) lines.push(`log line number ${lines.length}`);
  lines.push('{"progress": 0.9}');
  lines.push(complete);
  assert.strictEqual(lines.length, numLines, 'unexpected synthetic log size');
  return lines;
}

/** Starts the Easypanel API mock. Resolves with { url, queries, close }. */
function startMockEasypanel(lines) {
  // Timestamps must be later than the startNs the plugin captures when creating the service,
  // as with a real container that starts and begins writing.
  const base = BigInt(Date.now() + 10000) * 1000000n;
  const values = lines.map((line, i) => [String(base + BigInt(i) * 1000000n), line]);
  const queries = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op, fields } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') return send({ name: 'svc' });
      if (op === 'POST destroyAppService') return sendEmpty();
      if (op === 'GET listActions') {
        return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      }

      if (op === 'GET queryServiceLogs') {
        const start = fields.start;
        const limit = Number(fields.limit);
        if (limit > API_LIMIT_CAP) {
          return send({ defined: false, code: 'BAD_REQUEST', status: 400, message: 'Input validation failed' }, 400);
        }
        const page = values.filter(([ts]) => ts >= start).slice(0, limit).reverse();
        queries.push({ start, limit, returned: page.length });
        return send({ entries: [{ stream: { detected_level: 'unknown', stream: 'stdout' }, values: page }] });
      }

      send(NOT_FOUND, 404);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      queries,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

/** Runs the plugin against `url` and resolves with { code, stdout, timedOut }. */
function runPlugin(url, { env = {}, params = {}, job = {}, killAfterMs = 30000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PLUGIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, EASYPANEL_POLL_INTERVAL_MS: '100', EASYPANEL_DEPLOY_TOKEN: 'token', ...env },
    });

    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stdout += d; });

    child.stdin.end(JSON.stringify({
      id: 'testjob',
      ...job,
      params: {
        project_name: 'proj',
        service_name: 'svc',
        github_owner: 'owner',
        github_repo: 'repo',
        github_branch: 'main',
        easypanel_url: url,
        ...params,
      },
    }));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, timedOut: true });
    }, killAfterMs);

    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut: false });
    });
  });
}

/** Starts the mock, runs the plugin and stops the mock. */
async function runAgainst(lines, opts) {
  const mock = await startMockEasypanel(lines);
  try {
    const res = await runPlugin(mock.url, opts);
    return { ...res, queries: mock.queries };
  } finally {
    await mock.close();
  }
}

// ─── Basic flow ──────────────────────────────────────────────────────────────

test('completes a short job (24 lines)', async () => {
  const res = await runAgainst(containerLog(24));

  assert.strictEqual(res.timedOut, false, 'the job hung');
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /"complete":1,"code":0/);
});

// ─── Sliding log window ──────────────────────────────────────────────────────

test('completes a 102-line job: {"complete"} past a fixed 100-line window', async () => {
  // {"complete"} sits at index 101, two lines past the 100-line limit that the old code used
  // with a fixed `start`.
  const res = await runAgainst(containerLog(102));

  assert.strictEqual(res.timedOut, false, 'the job hung: the log window did not slide');
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /"complete":1,"code":0/);
  // Proves polling saw past line 100: this progress line is at index 99.
  assert.match(res.stdout, /90% complete/);
});

test('completes a 150-line job', async () => {
  const res = await runAgainst(containerLog(150));

  assert.strictEqual(res.timedOut, false, 'the job hung');
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /90% complete/);
});

test('drains a burst above the API cap of 1000 lines', async () => {
  const res = await runAgainst(containerLog(2500));

  assert.strictEqual(res.timedOut, false, 'the job hung');
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /90% complete/);

  // Needed more than one query, and at least one came back with a full window: that is the
  // drain path being exercised here.
  assert.ok(res.queries.length >= 3, `expected >=3 queries, got ${res.queries.length}`);
  assert.ok(
    res.queries.some(q => q.returned === q.limit),
    'no query came back with a full window'
  );
});

test('never asks for more than the 1000-line cap accepted by the API', async () => {
  const res = await runAgainst(containerLog(2500));

  assert.strictEqual(res.timedOut, false);
  for (const q of res.queries) {
    assert.ok(q.limit <= API_LIMIT_CAP, `limit ${q.limit} above the API cap`);
  }
});

// ─── Job result ──────────────────────────────────────────────────────────────

test('propagates a job failure (code != 0) with its description', async () => {
  const complete = JSON.stringify({
    complete: 1,
    code: 1,
    description: '1 error(s): step-3: precompute failed',
  });
  const res = await runAgainst(containerLog(102, complete));

  assert.strictEqual(res.timedOut, false, 'the job hung');
  assert.strictEqual(res.code, 1);
  assert.match(res.stdout, /step-3: precompute failed/);
});

// ─── Network robustness ──────────────────────────────────────────────────────

test('createService without response but the service exists: assumes success and proceeds', async () => {
  // Creation succeeded on the Easypanel side, but the HTTP response never arrived (dropped
  // connection). The plugin must not treat this as a failure and destroy a service that
  // already exists and is starting.
  const lines = containerLog(24);
  const base = BigInt(Date.now() + 10000) * 1000000n;
  const values = lines.map((line, i) => [String(base + BigInt(i) * 1000000n), line]);
  let created = false;
  let destroyed = false;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op, fields } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') {
        return created ? send({ name: 'svc' }) : send(NOT_FOUND, 404);
      }
      if (op === 'POST createAppService') {
        created = true;
        // A response that never reaches the client, although creation already happened.
        req.socket.destroy();
        return;
      }
      if (op === 'POST destroyAppService') {
        destroyed = true;
        return sendEmpty();
      }
      if (op === 'GET listActions') {
        return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      }
      if (op === 'GET queryServiceLogs') {
        const start = fields.start;
        const limit = Number(fields.limit);
        const page = values.filter(([ts]) => ts >= start).slice(0, limit).reverse();
        return send({ entries: [{ stream: { detected_level: 'unknown', stream: 'stdout' }, values: page }] });
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, {
      env: { EASYPANEL_HTTP_TIMEOUT_MS: '2000' },
      killAfterMs: 20000,
    });

    assert.strictEqual(res.timedOut, false, 'the job hung');
    assert.match(res.stdout, /Assuming success and proceeding/);
    assert.strictEqual(res.code, 0, `expected success, stdout:\n${res.stdout}`);
    // The service must not be destroyed because of the connection error; only the final
    // destroy at the normal end of the job should run.
    assert.doesNotMatch(res.stdout, /partially created/);
    assert.ok(destroyed, 'expected the final destroy at the end of the job');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('gives up quickly when no deploy action appears, without waiting the full deploy timeout', async () => {
  // The service "exists" but never produces a deployment action, like an orphan registered in
  // Easypanel that never actually triggered the deploy.
  let destroyed = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') return send({ name: 'svc' });
      if (op === 'POST destroyAppService') {
        destroyed = true;
        return sendEmpty();
      }
      if (op === 'GET listActions') return send([]);

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, {
      env: { EASYPANEL_DEPLOY_ACTION_TIMEOUT_MS: '500' },
      killAfterMs: 20000,
    });

    assert.strictEqual(res.timedOut, false, 'the job hung');
    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /no deploy action appeared/);
    assert.ok(destroyed, 'expected the orphan service to be destroyed');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('tolerates transient failures when querying the deploy action', async () => {
  // The first 3 listActions queries fail with 500 (< MAX_LIST_ACTION_FAILURES), then recover.
  // The deploy must complete normally, without aborting.
  const lines = containerLog(24);
  const base = BigInt(Date.now() + 10000) * 1000000n;
  const values = lines.map((line, i) => [String(base + BigInt(i) * 1000000n), line]);
  let listActionsCalls = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op, fields } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') return send({ name: 'svc' });
      if (op === 'POST destroyAppService') return sendEmpty();
      if (op === 'GET listActions') {
        listActionsCalls++;
        if (listActionsCalls <= 3) return send({ defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'unstable' }, 500);
        return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      }
      if (op === 'GET queryServiceLogs') {
        const start = fields.start;
        const limit = Number(fields.limit);
        const page = values.filter(([ts]) => ts >= start).slice(0, limit).reverse();
        return send({ entries: [{ stream: { detected_level: 'unknown', stream: 'stdout' }, values: page }] });
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, { killAfterMs: 20000 });

    assert.strictEqual(res.timedOut, false, 'the job hung');
    assert.strictEqual(res.code, 0, `expected success, stdout:\n${res.stdout}`);
    assert.match(res.stdout, /Failed to query deploy action \(1\/5\)/);
    assert.match(res.stdout, /Failed to query deploy action \(3\/5\)/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('aborts after consecutive failures when querying the deploy action', async () => {
  // listActions always fails (500), so the job must abort and destroy the service instead of
  // waiting for the 30-minute timeout.
  let destroyed = false;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') return send({ name: 'svc' });
      if (op === 'POST destroyAppService') {
        destroyed = true;
        return sendEmpty();
      }
      if (op === 'GET listActions') {
        return send({ defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'down' }, 500);
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, { killAfterMs: 20000 });

    assert.strictEqual(res.timedOut, false, 'the job hung');
    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /Deploy action query failed 5 times in a row/);
    assert.ok(destroyed, 'expected the service to be destroyed after exhausting retries');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('fails with an error when the connection hangs, instead of hanging', async () => {
  // Server that accepts the connection and never answers. The sockets hang on purpose, so they
  // must be destroyed by hand, otherwise close() never returns.
  const sockets = new Set();
  const blackhole = net.createServer(s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise(r => blackhole.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${blackhole.address().port}`;

  try {
    const res = await runPlugin(url, {
      env: { EASYPANEL_HTTP_TIMEOUT_MS: '1000' },
      killAfterMs: 20000,
    });

    assert.strictEqual(res.timedOut, false, 'the plugin hung on the request');
    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /Timeout of 1s on request/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise(r => blackhole.close(r));
  }
});

// ─── REST API contract (2.36.0) ──────────────────────────────────────────────

test('sends createAppService with a plain JSON body, no envelope', async () => {
  let createBody = null;
  let logsQuery = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op, fields } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') {
        createBody = fields;
        return send({ name: 'svc' });
      }
      if (op === 'POST destroyAppService') return sendEmpty();
      if (op === 'GET listActions') return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      if (op === 'GET queryServiceLogs') {
        logsQuery = fields;
        const ts = String(BigInt(Date.now() + 10000) * 1000000n);
        return send({ entries: [{ stream: {}, values: [[ts, '{"complete": 1, "code": 0}']] }] });
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, {
      killAfterMs: 20000,
      params: { override: '{"deploy": {"replicas": 2}}' },
    });

    assert.strictEqual(res.code, 0, `expected success, stdout:\n${res.stdout}`);
    assert.strictEqual(createBody.json, undefined, 'body should not have the {json} envelope');
    assert.strictEqual(createBody.projectName, 'proj');
    assert.strictEqual(createBody.serviceName, 'svc');
    assert.deepStrictEqual(createBody.source, {
      type: 'github', owner: 'owner', repo: 'repo', ref: 'main', path: '/', autoDeploy: false,
    });
    assert.deepStrictEqual(createBody.deploy, { command: null, replicas: 2 });
    assert.match(createBody.env, /^CRONICLE_JOB_ID=testjob$/m);
    assert.strictEqual(logsQuery.stream, 'stdout');
    assert.strictEqual(logsQuery.limit, String(API_LIMIT_CAP));
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('Advanced Logs disabled (400 "fetch failed"): aborts with a helpful message', async () => {
  let destroyed = false;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op } = parseCall(req, raw);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const sendEmpty = () => { res.writeHead(200); res.end(); };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') return send({ name: 'svc' });
      if (op === 'POST destroyAppService') {
        destroyed = true;
        return sendEmpty();
      }
      if (op === 'GET listActions') return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      if (op === 'GET queryServiceLogs') {
        // Actual 2.36.0 response on an instance without Advanced Logs/Loki configured.
        return send({ defined: false, code: 'BAD_REQUEST', status: 400, message: 'fetch failed' }, 400);
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await runPlugin(url, { killAfterMs: 20000 });

    assert.strictEqual(res.timedOut, false, 'the job hung');
    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /Advanced Logs/);
    assert.ok(destroyed, 'expected the service to be destroyed');
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ─── Secrets out of job.params ───────────────────────────────────────────────
// Cronicle writes job.params in plain text to the transaction log ("Job completed successfully"
// and "Job failed", via safeJobLog), but leaves the event Secret out: it reaches the plugin as
// environment variables, with the key names in job.secret_preview ("A|B|C").

/** Mock that records each call's Authorization header and the createAppService body. */
async function startCaptureMock() {
  const captured = { auth: new Set(), createBody: null };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { op, fields } = parseCall(req, raw);
      captured.auth.add(req.headers.authorization);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (op === 'GET inspectAppService') return send(NOT_FOUND, 404);
      if (op === 'POST createAppService') {
        captured.createBody = fields;
        return send({ name: 'svc' });
      }
      if (op === 'POST destroyAppService') { res.writeHead(200); return res.end(); }
      if (op === 'GET listActions') return send([{ id: 'a1', type: 'deployment', status: 'done' }]);
      if (op === 'GET queryServiceLogs') {
        const ts = String(BigInt(Date.now() + 10000) * 1000000n);
        return send({ entries: [{ stream: {}, values: [[ts, '{"complete": 1, "code": 0}']] }] });
      }

      send(NOT_FOUND, 404);
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    captured,
    close: () => new Promise(r => server.close(r)),
  };
}

test('forwards the event Secret variables to the service, and the API token comes from EASYPANEL_DEPLOY_TOKEN', async () => {
  const mock = await startCaptureMock();
  try {
    const res = await runPlugin(mock.url, {
      killAfterMs: 20000,
      env: {
        EASYPANEL_DEPLOY_TOKEN: 'secret-deploy',
        EASYPANEL_TOKEN: 'secret-ep',
        API_TOKEN: 'secret-api',
        OTHER_TOKEN: 'secret-other',
        NOT_IN_SECRET: 'do-not-forward',
      },
      job: { secret_preview: 'API_TOKEN|EASYPANEL_TOKEN|EASYPANEL_DEPLOY_TOKEN|OTHER_TOKEN' },
      params: { env_vars: '{"NODE_ENV": "production"}' },
    });

    assert.strictEqual(res.code, 0, `expected success, stdout:\n${res.stdout}`);
    assert.deepStrictEqual([...mock.captured.auth], ['Bearer secret-deploy']);
    assert.strictEqual(mock.captured.createBody.env, [
      'CRONICLE_JOB_ID=testjob',
      'NODE_ENV=production',
      'API_TOKEN=secret-api',
      'EASYPANEL_TOKEN=secret-ep',
      'OTHER_TOKEN=secret-other',
    ].join('\n'));
    assert.doesNotMatch(res.stdout, /secret-/);
  } finally {
    await mock.close();
  }
});

test('URL and token come from EASYPANEL_DEPLOY_* when the param is empty, and no EASYPANEL_DEPLOY_* is forwarded', async () => {
  const mock = await startCaptureMock();
  try {
    const res = await runPlugin('', {
      killAfterMs: 20000,
      env: { EASYPANEL_DEPLOY_URL: `${mock.url}/`, EASYPANEL_DEPLOY_TOKEN: 'secret-deploy' },
      job: { secret_preview: 'EASYPANEL_DEPLOY_URL|EASYPANEL_DEPLOY_TOKEN' },
    });

    assert.strictEqual(res.code, 0, `expected success, stdout:\n${res.stdout}`);
    assert.deepStrictEqual([...mock.captured.auth], ['Bearer secret-deploy']);
    assert.strictEqual(mock.captured.createBody.env, 'CRONICLE_JOB_ID=testjob');
  } finally {
    await mock.close();
  }
});

test('ignores the removed easypanel_token param: without EASYPANEL_DEPLOY_TOKEN the job fails', async () => {
  const mock = await startCaptureMock();
  try {
    const res = await runPlugin(mock.url, {
      killAfterMs: 20000,
      env: { EASYPANEL_DEPLOY_TOKEN: '' },
      params: { easypanel_token: 'legacy-token' },
    });

    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /Easypanel token not set/);
    assert.strictEqual(mock.captured.auth.size, 0, 'no API call should be made');
  } finally {
    await mock.close();
  }
});

test('an event Secret variable missing from the environment fails before creating the service', async () => {
  const mock = await startCaptureMock();
  try {
    const res = await runPlugin(mock.url, {
      killAfterMs: 20000,
      job: { secret_preview: 'NOT_DECRYPTED' },
    });

    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /\\"NOT_DECRYPTED\\" is missing from the job environment/);
    assert.strictEqual(mock.captured.createBody, null);
  } finally {
    await mock.close();
  }
});

test('a variable both in the Secret and in env_vars fails, so the secret does not stay in job.params', async () => {
  const mock = await startCaptureMock();
  try {
    const res = await runPlugin(mock.url, {
      killAfterMs: 20000,
      env: { API_TOKEN: 'secret-api' },
      job: { secret_preview: 'API_TOKEN' },
      params: { env_vars: '{"API_TOKEN": "secret-old"}' },
    });

    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /set both in \\"env_vars\\" and in the event Secret: API_TOKEN/);
    assert.strictEqual(mock.captured.createBody, null);
  } finally {
    await mock.close();
  }
});
