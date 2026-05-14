#!/usr/bin/env node

/**
 * Plugin Cronicle: Easypanel Deploy
 * ------------------------------------
 * Cria um serviço app no Easypanel a partir de um repositório GitHub
 * (build via Dockerfile), faz o deploy e monitora até a conclusão.
 *
 * PROTOCOLO CRONICLE (stdin/stdout JSON):
 *   - stdin: JSON com { job, params }
 *   - stdout: linhas JSON de progresso { progress: 0-1 } ou log { msg: "..." }
 *   - stdout final: { complete: 1, code: 0|1, description: "..." }
 *
 * PARÂMETROS (configurados na UI do Cronicle ao registrar o plugin):
 *   project_name          - Nome do projeto no Easypanel
 *   service_name          - Nome base do serviço
 *   service_name_as_prefix- Se true, sufixar com o job ID completo
 *   github_owner          - Dono do repositório GitHub
 *   github_repo           - Nome do repositório
 *   github_branch         - Branch a fazer build (ex: main)
 *   github_build_path     - Caminho do build dentro do repo (ex: /)
 *   dockerfile            - Caminho do Dockerfile (ex: Dockerfile)
 *   run_command           - Comando de runtime opcional (Advanced → Command no Easypanel)
 *   env_vars              - Variáveis de ambiente em JSON (ex: {"KEY": "value"})
 *   easypanel_url         - URL base do Easypanel (ex: https://panel.meudominio.com)
 *   easypanel_token       - Token da API (ou via env EASYPANEL_TOKEN)
 *
 * PROTOCOLO DO JOB (o script dentro do container):
 *   O job deve escrever linhas JSON no stdout seguindo o protocolo Cronicle:
 *     {"progress": 0.5}                                    ← progresso opcional
 *     {"complete": 1, "code": 0, "label": "Sucesso"}      ← encerramento com sucesso
 *     {"complete": 1, "code": 1, "description": "Erro"}   ← encerramento com falha
 *   O processo do container deve sempre sair com exit 0 (para o Easypanel não restartar).
 *   Requer Advanced Logs habilitado no Easypanel (usa Loki internamente).
 *
 * INSTALAÇÃO:
 *   1. chmod +x plugins/easypanel-deploy.js
 *   2. No Cronicle: Admin → Plugins → Add Plugin
 *      Command: /opt/cronicle/plugins/easypanel-deploy.js
 *      (ou importar conf/easypanel-plugin.json via control.sh import)
 */

'use strict';

const https = require('https');
const http = require('http');

// ─── Configuração ────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const TIMEOUT_MS = 24 * 60 * 60 * 1000;

const STATUS_SUCCESS = ['done', 'success', 'completed'];
const STATUS_FAILURE = ['error', 'failed', 'cancelled'];

// ─── Utilitários de log (protocolo Cronicle) ─────────────────────────────────

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
  log(`${Math.round(p * 100)}% concluído`);
}

function complete(description) {
  process.stdout.write(JSON.stringify({ complete: 1, code: 0, description }) + '\n');
  process.exit(0);
}

function fail(description) {
  process.stdout.write(JSON.stringify({ complete: 1, code: 1, description }) + '\n');
  process.exit(1);
}

// ─── Utilitários HTTP ─────────────────────────────────────────────────────────

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

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Funções da API do Easypanel (tRPC) ───────────────────────────────────────

function makeHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function trpcMutation(baseUrl, token, procedure, body) {
  const url = `${baseUrl}/api/trpc/${procedure}`;
  const res = await request({
    method: 'POST',
    url,
    headers: makeHeaders(token),
    body,
  });
  return res;
}

async function trpcQuery(baseUrl, token, procedure, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const url = `${baseUrl}/api/trpc/${procedure}?input=${encoded}`;
  const res = await request({
    method: 'GET',
    url,
    headers: makeHeaders(token),
  });
  return res;
}

async function inspectService(baseUrl, token, projectName, serviceName) {
  const res = await trpcQuery(baseUrl, token, 'services.app.inspectService', {
    projectName,
    serviceName,
  });
  if (res.status === 200 && res.body?.result?.data?.json) {
    return res.body.result.data.json;
  }
  return null;
}

async function destroyService(baseUrl, token, projectName, serviceName) {
  const res = await trpcMutation(baseUrl, token, 'services.app.destroyService', {
    json: { projectName, serviceName },
  });
  if (res.status !== 200) {
    throw new Error(`Falha ao destruir serviço: HTTP ${res.status}`);
  }
}

async function createService(baseUrl, token, params) {
  const body = {
    json: {
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
      deploy: {
        command: params.runCommand || null,
      },
    },
  };

  const res = await trpcMutation(baseUrl, token, 'services.app.createService', body);
  if (res.status !== 200) {
    const msg = res.body?.error?.message || JSON.stringify(res.body);
    throw new Error(`Falha ao criar serviço: HTTP ${res.status} — ${msg}`);
  }
}

async function deployService(baseUrl, token, projectName, serviceName) {
  const res = await trpcMutation(baseUrl, token, 'services.app.deployService', {
    json: { projectName, serviceName, forceRebuild: true },
  });
  if (res.status !== 200) {
    const msg = res.body?.error?.message || JSON.stringify(res.body);
    throw new Error(`Falha ao iniciar deploy: HTTP ${res.status} — ${msg}`);
  }
}

async function getLatestDeployAction(baseUrl, token, projectName, serviceName) {
  const res = await trpcQuery(baseUrl, token, 'actions.listActions', {
    projectName,
    serviceName,
    type: 'deployment',
    limit: 1,
  });

  if (res.status !== 200) return null;

  const items = res.body?.result?.data?.json;
  if (!Array.isArray(items) || items.length === 0) return null;

  return items[0];
}

async function getServiceLogs(baseUrl, token, projectName, serviceName, startNs) {
  const res = await trpcQuery(baseUrl, token, 'logs.queryServiceLogs', {
    projectName,
    serviceName,
    limit: 100,
    stream: 'stdout',
    start: startNs,
  });

  if (res.status === 500) {
    throw new Error(
      'Não foi possível ler os logs do serviço. Verifique se "Advanced Logs" está habilitado no Easypanel (requer Loki).'
    );
  }

  if (res.status !== 200) {
    throw new Error(`Falha ao buscar logs: HTTP ${res.status}`);
  }

  return res.body?.result?.data?.json?.entries || [];
}

function parseJobResult(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (const entry of entries) {
    for (const [_timestamp, line] of entry.values) {
      try {
        const jsonStart = line.indexOf('{');
        if (jsonStart === -1) continue;
        const parsed = JSON.parse(line.slice(jsonStart));
        if (parsed.complete === 1) return parsed;
      } catch {
        // linha de texto livre, ignorar
      }
    }
  }

  return null;
}

// ─── Funções auxiliares ───────────────────────────────────────────────────────

function envJsonToString(jsonStr) {
  if (!jsonStr || !jsonStr.trim() || jsonStr.trim() === '{}') return '';
  const obj = JSON.parse(jsonStr);
  return Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function sanitizeServiceName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

// ─── Loop de monitoramento ────────────────────────────────────────────────────

async function waitForDeploy(baseUrl, token, projectName, serviceName) {
  const startTime = Date.now();

  log(`Monitorando deploy de "${serviceName}"...`);

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed > TIMEOUT_MS) {
      throw new Error('Timeout de 24 horas atingido aguardando o deploy.');
    }

    const estimatedProgress = Math.min(0.95, (elapsed / TIMEOUT_MS) * 0.95);
    progress(estimatedProgress);

    const action = await getLatestDeployAction(baseUrl, token, projectName, serviceName);

    if (!action) {
      log('Aguardando action de deploy aparecer...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const status = (action.status || '').toLowerCase();
    log(`Status do deploy: "${status}"`);

    if (STATUS_SUCCESS.includes(status)) {
      log('Deploy concluído com sucesso.');
      return true;
    }

    if (STATUS_FAILURE.includes(status)) {
      const reason = action.error || action.message || status;
      throw new Error(`Deploy falhou com status "${status}": ${reason}`);
    }

    log(`Status "${status}" não é terminal — continuando polling...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function getServiceStats(baseUrl, token, projectName, serviceName) {
  try {
    const res = await trpcQuery(baseUrl, token, 'monitorOld.getServiceStats', {
      projectName,
      serviceName,
    });
    if (res.status === 200 && res.body?.result?.data?.json) {
      return res.body.result.data.json;
    }
  } catch {
    // stats são informativas, não críticas
  }
  return null;
}

function logServiceStats(stats) {
  if (!stats) return;

  const cpu = stats.cpu?.percent != null
    ? `CPU: ${stats.cpu.percent.toFixed(2)}%`
    : null;

  const memMB = stats.memory?.usage != null
    ? (stats.memory.usage / 1024 / 1024).toFixed(1)
    : null;
  const memPct = stats.memory?.percent != null
    ? stats.memory.percent.toFixed(2)
    : null;
  const mem = memMB && memPct ? `Memória: ${memMB} MB (${memPct}%)` : null;

  const netInMB = stats.network?.in != null
    ? (stats.network.in / 1024 / 1024).toFixed(2)
    : null;
  const netOutMB = stats.network?.out != null
    ? (stats.network.out / 1024 / 1024).toFixed(2)
    : null;
  const net = netInMB && netOutMB ? `Rede: ↓${netInMB} MB  ↑${netOutMB} MB` : null;

  const parts = [cpu, mem, net].filter(Boolean);
  if (parts.length > 0) {
    process.stdout.write(`[PERF] ${parts.join('  |  ')}\n`);
  }
}

async function waitForJobComplete(baseUrl, token, projectName, serviceName) {
  const startTime = Date.now();
  const startNs = String(startTime * 1_000_000);
  let lastSeenTs = startNs;
  const collectedLogs = [];

  log('Aguardando resultado do job nos logs...');

  await sleep(POLL_INTERVAL_MS);

  while (true) {
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Timeout de 24 horas atingido aguardando resultado do job.');
    }

    const entries = await getServiceLogs(baseUrl, token, projectName, serviceName, startNs);

    if (entries && entries.length > 0) {
      const newLines = [];
      for (const entry of entries) {
        for (const [ts, line] of entry.values) {
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
          // linha de texto livre, ignorar
        }
      }
    }

    const stats = await getServiceStats(baseUrl, token, projectName, serviceName);
    logServiceStats(stats);

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
    fail('Erro ao parsear o JSON de entrada do stdin.');
  }

  const required = ['project_name', 'service_name', 'github_owner', 'github_repo', 'github_branch', 'easypanel_url'];
  for (const key of required) {
    if (!params[key] || !String(params[key]).trim()) {
      fail(`Parâmetro obrigatório ausente: "${key}"`);
    }
  }

  const token = (params.easypanel_token || '').trim();
  if (!token) {
    fail('Token do Easypanel não informado. Configure o parâmetro "easypanel_token" no plugin.');
  }

  const baseUrl = params.easypanel_url.trim().replace(/\/+$/, '');
  const projectName = params.project_name.trim();

  const usePrefix = params.service_name_as_prefix == 1 || params.service_name_as_prefix === true;
  const rawName = usePrefix
    ? `${params.service_name}-${job.id}`
    : params.service_name;
  const serviceName = sanitizeServiceName(rawName);

  log(`Iniciando deploy do serviço: "${serviceName}" no projeto "${projectName}"`);
  log(`Repositório: ${params.github_owner}/${params.github_repo}@${params.github_branch}`);

  log('Verificando se o serviço já existe...');
  const existing = await inspectService(baseUrl, token, projectName, serviceName);

  if (existing) {
    fail(`O serviço "${serviceName}" já existe no projeto "${projectName}". Remova-o antes de executar o job.`);
  } else {
    log('Nenhum serviço existente. Prosseguindo com a criação.');
  }

  let envString = '';
  if (params.env_vars && params.env_vars.trim() && params.env_vars.trim() !== '{}') {
    try {
      envString = envJsonToString(params.env_vars);
    } catch {
      fail('O campo "env_vars" não é um JSON válido. Ex: {"CHAVE": "valor"}');
    }
  }

  log('Criando serviço no Easypanel...');
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
  });
  log('Serviço criado com sucesso.');

  await waitForDeploy(baseUrl, token, projectName, serviceName);

  const { result, logs } = await waitForJobComplete(baseUrl, token, projectName, serviceName);

  log('Destruindo serviço...');
  await destroyService(baseUrl, token, projectName, serviceName);
  log('Serviço destruído.');

  process.stdout.write('----------------------------------------------------------------------------\n');
  process.stdout.write('----------------------------------- LOGS -----------------------------------\n');
  process.stdout.write('----------------------------------------------------------------------------\n');
  for (const [ts, line] of logs) {
    process.stdout.write(`${formatTs(ts)} | ${line}\n`);
  }

  if (!result) {
    fail('Job não reportou status. O script do container deve escrever {"complete":1,"code":0} ao final.');
  }

  if (result.code !== 0) {
    fail(result.description || `Job encerrou com código de saída ${result.code}.`);
  }

  complete(result.label || `Job "${serviceName}" concluído com sucesso.`);
}

main().catch(err => {
  fail(`Erro inesperado: ${err.message}`);
});
