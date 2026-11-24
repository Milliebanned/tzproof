import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatYmd, localDate, parseShownDate, resolveDateExpr, sameDay } from './dates.js';
import { freePort, launchWarpedChrome } from './warp.js';

export function loadConfig(path) {
  const config = parseYaml(readFileSync(path, 'utf8'));
  const base = dirname(resolve(path));
  for (const key of ['clocks', 'flows']) {
    if (!Array.isArray(config[key]) || config[key].length === 0) {
      throw new Error(`${path}: "${key}" must be a non-empty list`);
    }
  }
  if (!config.app && !config.serve) throw new Error(`${path}: set "app" (a URL) or "serve" (a folder to serve)`);
  return { ...config, base, dateOrder: config.dateOrder || 'mdy' };
}

/** Every flow at every clock. */
export function planCells(config, { only } = {}) {
  const cells = [];
  for (const flow of config.flows) {
    for (const clock of config.clocks) {
      const id = `${flow.id}@${clock.id}`;
      if (only && !only.some(o => id.includes(o))) continue;
      cells.push({ id, flow, clock });
    }
  }
  return cells;
}

function fill(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

/** Compare what Kane read off the page with what the date should be in this cell. Kane's own pass/fail is not used. */
export function judge(cell, kane, dateOrder) {
  const atMs = Date.parse(cell.clock.at);
  const checks = [];
  for (const [key, spec] of Object.entries(cell.flow.expect || {})) {
    const exprText = typeof spec === 'string' ? spec : spec.date;
    const order = (typeof spec === 'object' && spec.order) || dateOrder;
    const expected = resolveDateExpr(exprText, atMs, cell.clock.tz);
    const shownRaw = kane.finalState?.[key];
    const shown = parseShownDate(shownRaw, order);
    let status;
    let reason;
    if (shownRaw === undefined || shownRaw === null || shownRaw === '') {
      status = 'unknown';
      reason = `Kane did not record "${key}"`;
    }
    else if (!shown) {
      status = 'unknown';
      reason = `"${shownRaw}" is not a recognisable date`;
    }
    else if (sameDay(shown, expected)) {
      status = 'pass';
    }
    else {
      status = 'fail';
      const diff = Math.round((Date.UTC(shown.y, shown.m - 1, shown.d) - Date.UTC(expected.y, expected.m - 1, expected.d)) / 86400000);
      reason = `shows ${formatYmd(shown)}, expected ${formatYmd(expected)} (${diff > 0 ? '+' : ''}${diff} day${Math.abs(diff) === 1 ? '' : 's'})`;
    }
    checks.push({ key, rule: exprText, expected: formatYmd(expected), shownRaw: shownRaw ?? null, shown: shown && formatYmd(shown), status, reason });
  }

  let verdict;
  if (kane.exitCode === 2 || kane.exitCode === 3 || !kane.runEnd) verdict = 'unknown';
  else if (checks.some(c => c.status === 'fail')) verdict = 'fail';
  else if (checks.length && checks.every(c => c.status === 'pass')) verdict = 'pass';
  else verdict = 'unknown';
  return { verdict, checks };
}

function runKane({ objective, endpoint, variables, maxSteps, timeout, ndjsonPath }) {
  return new Promise((resolvePromise) => {
    const args = ['run', objective, '--agent', '--cdp-endpoint', endpoint,
      '--max-steps', String(maxSteps), '--timeout', String(timeout)];
    if (Object.keys(variables).length) args.push('--variables', JSON.stringify(variables));
    const child = spawn('kane-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => {
      writeFileSync(ndjsonPath, stdout);
      const events = stdout.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; }
        catch { return []; }
      });
      const runEnd = events.find(e => e.type === 'run_end') || null;
      const evidence = stderr.match(/evidence serve (\S+\.evidence)/)?.[1] || null;
      resolvePromise({
        exitCode,
        runEnd,
        finalState: runEnd?.final_state || {},
        steps: events.filter(e => e.step !== undefined && e.status !== 'running'),
        evidence,
        stderrTail: stderr.trim().split('\n').slice(-3).join('\n'),
      });
    });
  });
}

function secretVariables(config) {
  const out = {};
  for (const [name, spec] of Object.entries(config.secrets || {})) {
    const value = spec?.env ? process.env[spec.env] : spec?.value;
    if (value === undefined) throw new Error(`Secret "${name}" is not set (expected env ${spec?.env})`);
    out[name] = { value, secret: true };
  }
  return out;
}

function runBefore(command, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('close', code => (code === 0 ? resolvePromise() : reject(new Error(`"before" command exited with ${code}`))));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export async function serveFolder(folder) {
  const port = await freePort();
  const root = resolve(folder);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = join(root, urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
    }
    catch {
      try {
        file = join(root, 'index.html');
        res.writeHead(200, { 'content-type': MIME['.html'] }).end(readFileSync(file));
      }
      catch {
        res.writeHead(404).end('not found');
      }
    }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

/**
 * Run every cell and return the results object (also written to <outDir>/results.json).
 */
export async function runGrid(config, { outDir, parallel = 2, headless = true, only, log = console.log } = {}) {
  const cells = planCells(config, { only });
  mkdirSync(join(outDir, 'cells'), { recursive: true });

  const served = config.serve ? await serveFolder(resolve(config.base, config.serve)) : null;
  const app = served ? served.url : config.app;
  const secrets = secretVariables(config);
  const startedAt = new Date().toISOString();
  const results = [];
  let next = 0;

  async function worker() {
    while (next < cells.length) {
      const cell = cells[next++];
      const atMs = Date.parse(cell.clock.at);
      const vars = { app, tz: cell.clock.tz, at: cell.clock.at, today: formatYmd(localDate(atMs, cell.clock.tz)) };
      const objective = fill(cell.flow.objective, vars).replace(/\s+/g, ' ').trim();
      const safeId = cell.id.replace(/[^\w.@-]+/g, '_');
      log(`… ${cell.id}  (${cell.clock.tz}, ${cell.clock.at})`);

      if (config.before) {
        await runBefore(config.before, config.base, {
          TZPROOF_APP: app, TZPROOF_TZ: cell.clock.tz, TZPROOF_AT: cell.clock.at, TZPROOF_TODAY: vars.today, TZPROOF_CELL: cell.id,
        });
      }

      const chrome = await launchWarpedChrome({ tz: cell.clock.tz, at: cell.clock.at, headless });
      const t0 = Date.now();
      let kane;
      try {
        kane = await runKane({
          objective,
          endpoint: chrome.endpoint,
          variables: secrets,
          maxSteps: cell.flow.maxSteps || config.maxSteps || 25,
          timeout: cell.flow.timeout || config.timeout || 300,
          ndjsonPath: join(outDir, 'cells', `${safeId}.ndjson`),
        });
      }
      finally {
        await chrome.close();
      }
      const { verdict, checks } = judge(cell, kane, config.dateOrder);
      const icon = { pass: '✓', fail: '✗', unknown: '?' }[verdict];
      log(`${icon} ${cell.id}  ${checks.map(c => c.reason || `${c.key} ok`).join('; ') || kane.stderrTail}`);
      results.push({
        id: cell.id,
        flow: cell.flow.id,
        flowName: cell.flow.name || cell.flow.id,
        clock: cell.clock,
        verdict,
        checks,
        objective,
        kane: {
          exitCode: kane.exitCode,
          status: kane.runEnd?.status ?? null,
          summary: kane.runEnd?.summary ?? null,
          credits: kane.runEnd?.credits ?? null,
          duration: kane.runEnd?.duration ?? Math.round((Date.now() - t0) / 1000),
          testUrl: kane.runEnd?.test_url ?? null,
          evidence: kane.evidence,
          steps: kane.steps.map(s => ({ step: s.step, status: s.status, remark: s.remark })),
          ndjson: `cells/${safeId}.ndjson`,
        },
      });
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, cells.length)) }, worker));
  }
  finally {
    await served?.close();
  }

  const order = new Map(cells.map((c, i) => [c.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));
  const summary = {
    pass: results.filter(r => r.verdict === 'pass').length,
    fail: results.filter(r => r.verdict === 'fail').length,
    unknown: results.filter(r => r.verdict === 'unknown').length,
  };
  const out = {
    tool: 'tzproof',
    startedAt,
    finishedAt: new Date().toISOString(),
    app,
    clocks: config.clocks,
    flows: config.flows.map(f => ({ id: f.id, name: f.name || f.id })),
    summary,
    cells: results,
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2));
  return out;
}
