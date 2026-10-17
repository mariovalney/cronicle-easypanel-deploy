#!/usr/bin/env node

// See README.md for documentation, parameters, and job protocol.

'use strict';

const https = require('https');
const http = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────

// Poll interval, HTTP timeout and deploy action timeout can be overridden by env, for the
// automated tests and for environments with unusual latency.
const POLL_INTERVAL_MS = parseInt(process.env.EASYPANEL_POLL_INTERVAL_MS, 10) || 5000;
const HTTP_TIMEOUT_MS = parseInt(process.env.EASYPANEL_HTTP_TIMEOUT_MS, 10) || 120 * 1000;
// Separate from DEPLOY_TIMEOUT_MS: if no deploy action ever shows up (e.g. an orphan service that
// never triggered a deploy), there is no point in waiting the full 30 minutes to give up.
const DEPLOY_ACTION_TIMEOUT_MS = parseInt(process.env.EASYPANEL_DEPLOY_ACTION_TIMEOUT_MS, 10) || 5 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;
const JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_ACTION_FAILURES = 5;

// Maximum lines per Loki query. 1000 is the cap enforced by the Easypanel API itself; larger
// values are rejected with BAD_REQUEST.
const LOG_QUERY_LIMIT = 1000;
const MAX_LOG_QUERY_FAILURES = 5;
const LOG_HEARTBEAT_EVERY = 12;

const STATUS_SUCCESS = ['done', 'success', 'completed'];
const STATUS_FAILURE = ['error', 'failed', 'cancelled'];

// Variables with this prefix configure the plugin itself and are never forwarded to the service.
// The prefix keeps the plugin's API token apart from an EASYPANEL_TOKEN the service may need.
const PLUGIN_ENV_PREFIX = 'EASYPANEL_DEPLOY_';
const API_URL_ENV = `${PLUGIN_ENV_PREFIX}URL`;
const API_TOKEN_ENV = `${PLUGIN_ENV_PREFIX}TOKEN`;

// ─── Logging (Cronicle protocol) ──────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[INFO] ${msg}\n`);
}

function formatTs(nsTimestamp) {
  const date = new Date(parseInt(nsTimestamp) / 1_000_000);
  return date.toTimeString().slice(0, 8);
}

function progress(value) {
  const p = Math.min(Math.max(value, 0), 1);
  process.stdout.write(JSON.stringify({ progress: p }) + '\n');
  log(`${Math.round(p * 100)}% complete`);
}

function complete(description) {
  process.stdout.write(JSON.stringify({ complete: 1, code: 0, description }) + '\n');
  process.exit(0);
}

function fail(description) {
  process.stdout.write(JSON.stringify({ complete: 1, code: 1, description }) + '\n');
  process.exit(1);
}

// ─── HTTP utilities ───────────────────────────────────────────────────────────

// Always applies HTTP_TIMEOUT_MS: a connection that hangs without a socket error would otherwise
// leave the Promise pending forever, and the deploy and job timeouts are only checked between
// requests.
function request(options) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const lib = url.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const body = options.body ? JSON.stringify(options.body) : null;
    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout of ${HTTP_TIMEOUT_MS / 1000}s on request to ${url.pathname}`));
    });

    // Socket error (the timeout above or a connection failure): no response was received, so we
    // don't know whether the server processed the request. Flagged so callers can treat it as
    // "unknown outcome" instead of "failed" where that matters.
    req.on('error', (err) => {
      err.noResponse = true;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Easypanel API (REST) ─────────────────────────────────────────────────────

function makeHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
  };
}

async function apiGet(baseUrl, token, operation, query) {
  const url = new URL(`${baseUrl}/api/${operation}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return request({
    method: 'GET',
    url: url.toString(),
    headers: makeHeaders(token),
  });
}

async function apiPost(baseUrl, token, operation, body) {
  return request({
    method: 'POST',
    url: `${baseUrl}/api/${operation}`,
    headers: makeHeaders(token),
    body,
  });
}

// Error body format: { code, status, message, data?: { zodErrors } }
function apiErrorMessage(res) {
  const body = res.body;
  if (body && typeof body === 'object' && body.message) {
    const zod = body.data?.zodErrors;
    return zod ? `${body.message} ${JSON.stringify(zod)}` : body.message;
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}

// Returns the service, or null when it does not exist (the API answers 404 NOT_FOUND).
async function inspectService(baseUrl, token, projectName, serviceName) {
  const res = await apiGet(baseUrl, token, 'inspectAppService', { projectName, serviceName });
  if (res.status === 200 && res.body && typeof res.body === 'object') {
    return res.body;
  }
  return null;
}

async function destroyService(baseUrl, token, projectName, serviceName) {
  const res = await apiPost(baseUrl, token, 'destroyAppService', { projectName, serviceName });
  if (res.status !== 200) {
    throw new Error(`Failed to destroy service: HTTP ${res.status} - ${apiErrorMessage(res)}`);
  }
}

// Creating the service already starts the deploy; there is no separate deploy call.
async function createService(baseUrl, token, params) {
  const body = {
    projectName: params.projectName,
    serviceName: params.serviceName,
    source: {
      type: 'github',
      owner: params.githubOwner,
      repo: params.githubRepo,
      ref: params.githubBranch,
      path: params.githubBuildPath || '/',
      autoDeploy: false,
    },
    build: {
      type: 'dockerfile',
      file: params.dockerfile || 'Dockerfile',
    },
    env: params.envString || '',
    mounts: params.mounts || [],
    deploy: {
      command: params.runCommand || null,
    },
  };

  if (params.override) {
    deepMerge(body, params.override);
  }

  const res = await apiPost(baseUrl, token, 'createAppService', body);
  if (res.status !== 200) {
    throw new Error(`Failed to create service: HTTP ${res.status} - ${apiErrorMessage(res)}`);
  }
}

// Returns the latest deploy action, or null if none exists yet. Throws on HTTP failure so the
// caller decides how to handle it.
async function getLatestDeployAction(baseUrl, token, projectName, serviceName) {
  const res = await apiGet(baseUrl, token, 'listActions', {
    projectName, serviceName, type: 'deployment', limit: 1,
  });

  if (res.status !== 200) {
    throw new Error(`Failed to list actions: HTTP ${res.status} - ${apiErrorMessage(res)}`);
  }

  const items = res.body;
  if (!Array.isArray(items) || items.length === 0) return null;

  return items[0];
}

// The API returns the LOG_QUERY_LIMIT OLDEST lines from `startNs`, and `start` is inclusive.
// There is no direction parameter: callers must advance `startNs` to page.
// Without Advanced Logs, 2.36.0 answers HTTP 400 "fetch failed" (2.32.x answered HTTP 500).
async function getServiceLogs(baseUrl, token, projectName, serviceName, startNs) {
  const res = await apiGet(baseUrl, token, 'queryServiceLogs', {
    projectName, serviceName, limit: LOG_QUERY_LIMIT, stream: 'stdout', start: startNs,
  });

  if (res.status === 500 || (res.status === 400 && res.body?.message === 'fetch failed')) {
    throw new Error(
      'Could not read service logs. Make sure "Advanced Logs" is enabled in Easypanel (requires Loki).'
    );
  }

  if (res.status !== 200) {
    throw new Error(`Failed to fetch logs: HTTP ${res.status} - ${apiErrorMessage(res)}`);
  }

  return res.body?.entries || [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function envJsonToString(jsonStr) {
  if (!jsonStr || !jsonStr.trim() || jsonStr.trim() === '{}') return '';
  const obj = JSON.parse(jsonStr);
  return Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

// Returns the event Secret variables in Easypanel's multiline env format.
// Cronicle writes job.params in plain text to the transaction log, but leaves the event Secret out:
// its values reach the plugin only as environment variables, and its key names come in
// job.secret_preview ("A|B|C"). Plugin, category and global Secrets have no such list.
function eventSecretToString(names, env) {
  return names
    .map(name => {
      if (env[name] === undefined) {
        throw new Error(`Event Secret variable "${name}" is missing from the job environment. Check the Cronicle error log for a Secret decryption failure.`);
      }
      return `${name}=${env[name]}`;
    })
    .join('\n');
}

// Arrays and primitives in `override` replace the target value; objects are merged recursively.
function deepMerge(target, override) {
  for (const [key, value] of Object.entries(override)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function sanitizeServiceName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

// ─── Polling loops ────────────────────────────────────────────────────────────

// Two timeouts: if the deploy action never shows up, give up after DEPLOY_ACTION_TIMEOUT_MS;
// once it shows up, DEPLOY_TIMEOUT_MS applies to the deploy itself. Up to
// MAX_LIST_ACTION_FAILURES consecutive query failures are tolerated, so a single network error
// does not abort a deploy that is progressing normally.
async function waitForDeploy(baseUrl, token, projectName, serviceName) {
  const startTime = Date.now();
  let actionSeen = false;
  let failures = 0;

  log(`Monitoring deploy of "${serviceName}"...`);

  while (true) {
    const elapsed = Date.now() - startTime;

    if (!actionSeen && elapsed > DEPLOY_ACTION_TIMEOUT_MS) {
      throw new Error(`${DEPLOY_ACTION_TIMEOUT_MS / 60000}-minute timeout reached: no deploy action appeared.`);
    }

    if (elapsed > DEPLOY_TIMEOUT_MS) {
      throw new Error('30-minute timeout reached waiting for deploy.');
    }

    const estimatedProgress = Math.min(0.95, (elapsed / DEPLOY_TIMEOUT_MS) * 0.95);
    progress(estimatedProgress);

    let action;
    try {
      action = await getLatestDeployAction(baseUrl, token, projectName, serviceName);
      failures = 0;
    } catch (err) {
      failures++;
      if (failures >= MAX_LIST_ACTION_FAILURES) {
        throw new Error(`Deploy action query failed ${failures} times in a row: ${err.message}`);
      }
      process.stdout.write(`[WARN] Failed to query deploy action (${failures}/${MAX_LIST_ACTION_FAILURES}): ${err.message}\n`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!action) {
      log('Waiting for deploy action to appear...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    actionSeen = true;

    const status = (action.status || '').toLowerCase();
    log(`Deploy status: "${status}"`);

    if (STATUS_SUCCESS.includes(status)) {
      log('Deploy completed successfully.');
      return true;
    }

    if (STATUS_FAILURE.includes(status)) {
      const reason = action.error || action.message || status;
      throw new Error(`Deploy failed with status "${status}": ${reason}`);
    }

    log(`Status "${status}" is not terminal, continuing to poll...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// THE LOG WINDOW MUST SLIDE. The API returns the LOG_QUERY_LIMIT oldest lines from `start`, with
// a hard cap of 1000. With `start` fixed at the job start, any container writing more lines than
// the limit would have its {"complete"} line permanently out of the window, and the job would hang
// until the 24-hour timeout. So every query uses the last seen timestamp as the new `start`.
//
// `startNs` must be captured BEFORE the service is created, so lines the container writes before
// waitForDeploy() confirms success are not lost.
async function waitForJobComplete(baseUrl, token, projectName, serviceName, startNs) {
  const startTime = Date.now();
  let lastSeenTs = startNs;
  const collectedLogs = [];
  let pollCount = 0;
  let failures = 0;

  log('Waiting for job result in logs...');

  await sleep(POLL_INTERVAL_MS);

  while (true) {
    if (Date.now() - startTime > JOB_TIMEOUT_MS) {
      throw new Error('24-hour timeout reached waiting for job result.');
    }

    pollCount++;
    let newThisPoll = 0;

    // Drain while the window comes back full: since the limit is the API cap, a full response
    // means newer lines are still waiting to be read.
    while (true) {
      let entries;
      try {
        entries = await getServiceLogs(baseUrl, token, projectName, serviceName, lastSeenTs);
        failures = 0;
      } catch (err) {
        failures++;
        if (failures >= MAX_LOG_QUERY_FAILURES) {
          throw new Error(`Log query failed ${failures} times in a row: ${err.message}`);
        }
        process.stdout.write(`[WARN] Failed to query logs (${failures}/${MAX_LOG_QUERY_FAILURES}): ${err.message}\n`);
        break;
      }

      // `start` is inclusive, so the edge line comes back on every query: filter by timestamp.
      const newLines = [];
      let returned = 0;
      for (const entry of entries) {
        for (const [ts, line] of entry.values) {
          returned++;
          if (ts > lastSeenTs) newLines.push([ts, line]);
        }
      }

      newLines.sort((a, b) => (a[0] < b[0] ? -1 : 1));

      for (const [ts, line] of newLines) {
        if (ts > lastSeenTs) lastSeenTs = ts;

        collectedLogs.push([ts, line]);

        try {
          const jsonStart = line.indexOf('{');
          if (jsonStart === -1) continue;
          const parsed = JSON.parse(line.slice(jsonStart));

          if (parsed.complete === 1) return { result: parsed, logs: collectedLogs };

          if (typeof parsed.progress === 'number') {
            progress(parsed.progress);
          }
        } catch {
          // free-form text line, ignore
        }
      }

      newThisPoll += newLines.length;

      if (returned < LOG_QUERY_LIMIT) break;

      // Full window with nothing new only happens when LOG_QUERY_LIMIT lines share the edge
      // timestamp. Draining further would loop forever.
      if (newLines.length === 0) {
        process.stdout.write('[WARN] Log window full with no new lines; lines sharing the same timestamp may be lost.\n');
        break;
      }
    }

    if (pollCount % LOG_HEARTBEAT_EVERY === 0) {
      const mins = Math.round((Date.now() - startTime) / 60000);
      process.stdout.write(
        `[DEBUG] poll #${pollCount} (${mins} min): ${collectedLogs.length} lines read, ` +
        `${newThisPoll} new this cycle, last ts ${lastSeenTs}\n`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let job, params;
  try {
    job = JSON.parse(input);
    params = job.params || {};
  } catch {
    fail('Failed to parse stdin JSON input.');
  }

  const required = ['project_name', 'service_name', 'github_owner', 'github_repo', 'github_branch'];
  for (const key of required) {
    if (!params[key] || !String(params[key]).trim()) {
      fail(`Missing required parameter: "${key}"`);
    }
  }

  const token = process.env[API_TOKEN_ENV] || '';
  if (!token) {
    fail(`Easypanel token not set. Configure ${API_TOKEN_ENV} in the Cronicle container env or in the plugin Secret.`);
  }

  const baseUrl = ((params.easypanel_url || '').trim() || process.env[API_URL_ENV] || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    fail(`Easypanel URL not set. Configure ${API_URL_ENV} in the Cronicle container env or in the plugin Secret.`);
  }

  const projectName = params.project_name.trim();

  const usePrefix = params.service_name_as_prefix == 1 || params.service_name_as_prefix === true;
  const rawName = usePrefix
    ? `${params.service_name}-${job.id}`
    : params.service_name;
  const serviceName = sanitizeServiceName(rawName);

  log(`Starting deploy of service "${serviceName}" in project "${projectName}"`);
  log(`Repository: ${params.github_owner}/${params.github_repo}@${params.github_branch}`);

  log('Checking if service already exists...');
  const existing = await inspectService(baseUrl, token, projectName, serviceName);

  if (existing) {
    fail(`Service "${serviceName}" already exists in project "${projectName}". Remove it before running the job.`);
  } else {
    log('No existing service found. Proceeding with creation.');
  }

  let envString = '';
  if (params.env_vars && params.env_vars.trim() && params.env_vars.trim() !== '{}') {
    try {
      envString = envJsonToString(params.env_vars);
    } catch {
      fail('The "env_vars" field is not valid JSON. Example: {"KEY": "value"}');
    }
  }

  const secretNames = (job.secret_preview || '').split('|').filter(name => name && !name.startsWith(PLUGIN_ENV_PREFIX));
  let secretEnv = '';
  try {
    secretEnv = eventSecretToString(secretNames, process.env);
  } catch (err) {
    fail(err.message);
  }

  // A variable both in the event Secret and in env_vars means an incomplete migration: its value
  // would keep reaching the transaction log through env_vars.
  const plainKeys = new Set(envString.split('\n').map(line => line.split('=')[0]));
  const duplicated = secretNames.filter(name => plainKeys.has(name));
  if (duplicated.length) {
    fail(`Variables set both in "env_vars" and in the event Secret: ${duplicated.join(', ')}. Remove them from "env_vars".`);
  }

  // CRONICLE_JOB_ID is always injected, so the container can tell which Cronicle job started it.
  envString = [`CRONICLE_JOB_ID=${job.id}`, envString, secretEnv].filter(Boolean).join('\n');

  let mounts = [];
  if (params.mounts && params.mounts.trim()) {
    try {
      mounts = JSON.parse(params.mounts);
    } catch {
      fail('The "mounts" field is not valid JSON. Example: [{"hostPath": "/host/path", "mountPath": "/container/path", "type": "bind"}]');
    }
    if (!Array.isArray(mounts)) {
      fail('The "mounts" field must be a JSON array. Example: [{"hostPath": "/host/path", "mountPath": "/container/path", "type": "bind"}]');
    }
  }

  let override = null;
  if (params.override && params.override.trim()) {
    try {
      override = JSON.parse(params.override);
    } catch {
      fail('The "override" field is not valid JSON. Example: {"deploy": {"replicas": 2}}');
    }
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      fail('The "override" field must be a JSON object. Example: {"deploy": {"replicas": 2}}');
    }
  }

  // Captured BEFORE creating the service, so lines the container writes right after starting
  // (before waitForDeploy() confirms success) are not lost.
  const jobLogStartNs = String(Date.now() * 1_000_000);
  log('Creating service in Easypanel...');
  try {
    await createService(baseUrl, token, {
      projectName,
      serviceName,
      githubOwner: params.github_owner.trim(),
      githubRepo: params.github_repo.trim(),
      githubBranch: params.github_branch.trim(),
      githubBuildPath: (params.github_build_path || '/').trim(),
      dockerfile: (params.dockerfile || 'Dockerfile').trim(),
      runCommand: (params.run_command || '').trim() || null,
      envString,
      mounts,
      override,
    });
  } catch (createErr) {
    const partial = await inspectService(baseUrl, token, projectName, serviceName);

    if (createErr.noResponse && partial) {
      // No response (timeout or connection error), but the service exists: creation most likely
      // succeeded and only the response was lost. Unlike an explicit HTTP error, there is no
      // reason to destroy a service that may already be running fine.
      log(`No response when creating service (${createErr.message}), but the service exists. Assuming success and proceeding.`);
    } else if (partial) {
      log('Service creation failed but service was partially created. Rolling back...');
      try {
        await destroyService(baseUrl, token, projectName, serviceName);
        log('Partial service destroyed.');
      } catch (destroyErr) {
        log(`Warning: failed to destroy partial service: ${destroyErr.message}`);
      }
      throw createErr;
    } else {
      throw createErr;
    }
  }
  log('Service created successfully.');

  let result, logs;
  try {
    await waitForDeploy(baseUrl, token, projectName, serviceName);
    ({ result, logs } = await waitForJobComplete(baseUrl, token, projectName, serviceName, jobLogStartNs));
  } catch (runErr) {
    log('Error during execution. Rolling back service...');
    try {
      await destroyService(baseUrl, token, projectName, serviceName);
      log('Service destroyed.');
    } catch (destroyErr) {
      log(`Warning: failed to destroy service: ${destroyErr.message}`);
    }
    throw runErr;
  }

  log('Destroying service...');
  await destroyService(baseUrl, token, projectName, serviceName);
  log('Service destroyed.');

  process.stdout.write('----------------------------------------------------------------------------\n');
  process.stdout.write('----------------------------------- LOGS -----------------------------------\n');
  process.stdout.write('----------------------------------------------------------------------------\n');
  for (const [ts, line] of logs) {
    process.stdout.write(`${formatTs(ts)} | ${line}\n`);
  }

  if (!result) {
    fail('Job did not report a status. The container script must write {"complete":1,"code":0} before exiting.');
  }

  if (result.code !== 0) {
    fail(result.description || `Job exited with code ${result.code}.`);
  }

  complete(result.label || `Job "${serviceName}" completed successfully.`);
}

main().catch(err => {
  fail(`Unexpected error: ${err.message}`);
});
