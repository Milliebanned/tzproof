import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { formatYmd, localDate, parseShownDate, resolveDateExpr, sameDay } from './dates.js';
import { freePort, launchWarpedChrome } from './warp.js';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function spokenDate({ y, m, d }) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Ask Kane to assert each expected date itself, as a second check independent of tzproof's own comparison.
 * The verdict still comes from tzproof; the two are compared in the report.
 */
export function withKaneAssertions(objective, cell, config) {
  if (config.kaneAssert === false || !cell.flow.expect) return objective;
  const atMs = Date.parse(cell.clock.at);
  const expectations = Object.entries(cell.flow.expect).map(([key, spec]) => {
    const expected = resolveDateExpr(typeof spec === 'string' ? spec : spec.date, atMs, cell.clock.tz);
    return `'${key}' is ${spokenDate(expected)}`;
  });
  return `${objective.trim()} Store all of those values first. Only after every value is stored, verify that each stored date is the correct calendar day, whatever format the page uses: ${expectations.join('; ')}.`;
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

/**
 * Every value Kane read. `final_state` is empty when one of Kane's own checks fails, but the values it stored
 * along the way are still in the run's context, and tzproof needs them to give its own verdict.
 */
export function valuesRead(runEnd) {
  const values = {};
  for (const [key, v] of Object.entries(runEnd?.context?.variables || {})) {
    if (v && v.type === 'memory' && v.value !== undefined) values[key] = v.value;
  }
  return { ...values, ...(runEnd?.final_state || {}) };
}

/**
 * Copy one screenshot out of a Kane evidence pack: the page as Kane saw it, just after it loaded.
 * Needs `unzip`; returns null when it isn't available or the pack has no screenshots.
 */
export function extractScreenshot(pack, dest) {
  if (!pack) return null;
  const list = spawnSync('unzip', ['-Z1', pack], { encoding: 'utf8' });
  if (list.status !== 0) return null;
  const shots = list.stdout.split('\n').filter(f => /\/steps\/[^/]+\/screenshot\.(jpe?g|png)$/.test(f))
    .sort((a, b) => Number(a.match(/steps\/(\d+)/)?.[1]) - Number(b.match(/steps\/(\d+)/)?.[1]));
  const pick = shots[1] || shots[0];
  if (!pick) return null;
  const out = spawnSync('unzip', ['-p', pack, pick], { maxBuffer: 20 * 1024 * 1024 });
  if (out.status !== 0 || !out.stdout?.length) return null;
  writeFileSync(dest, out.stdout);
  return dest;
}

function runKane({ objective, endpoint, variables, maxSteps, timeout, ndjsonPath, onStep = () => {} }) {
  return new Promise((resolvePromise) => {
    // A failed date check must not end the run: tzproof still needs every value Kane read.
    const args = ['run', objective, '--agent', '--cdp-endpoint', endpoint,
      '--max-steps', String(maxSteps), '--timeout', String(timeout), '--assertion-failure-mode', 'continue'];
    if (Object.keys(variables).length) args.push('--variables', JSON.stringify(variables));
    const child = spawn('kane-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      const lines = (pendingLine + d).split('\n');
      pendingLine = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.step !== undefined && event.remark) onStep(event);
        }
        catch { /* partial or non-JSON line */ }
      }
    });
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
        finalState: valuesRead(runEnd),
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
export async function runGrid(config, { outDir, parallel = 2, headless = true, only, log = console.log, emit = () => {} } = {}) {
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
      const objective = withKaneAssertions(fill(cell.flow.objective, vars), cell, config).replace(/\s+/g, ' ').trim();
      const safeId = cell.id.replace(/[^\w.@-]+/g, '_');
      log(`… ${cell.id}  (${cell.clock.tz}, ${cell.clock.at})`);
      emit('cell-start', { id: cell.id });

      if (config.before) {
        await runBefore(config.before, config.base, {
          TZPROOF_APP: app, TZPROOF_TZ: cell.clock.tz, TZPROOF_AT: cell.clock.at, TZPROOF_TODAY: vars.today, TZPROOF_CELL: cell.id,
        });
      }

      const t0 = Date.now();
      const maxTries = 1 + (config.retries ?? 1);
      let kane;
      let verdict;
      let checks;
      let tries = 0;
      let retry = false;
      // A run that records nothing because the browser session broke (not because of the app) is retried once.
      // Retries are reported; a cell never passes on a run that didn't record its values.
      do {
        tries++;
        const chrome = await launchWarpedChrome({ tz: cell.clock.tz, at: cell.clock.at, headless });
        try {
          kane = await runKane({
            objective,
            endpoint: chrome.endpoint,
            variables: secrets,
            maxSteps: cell.flow.maxSteps || config.maxSteps || 25,
            timeout: cell.flow.timeout || config.timeout || 300,
            ndjsonPath: join(outDir, 'cells', `${safeId}${tries > 1 ? `.try${tries}` : ''}.ndjson`),
            onStep: e => emit('cell-step', { id: cell.id, step: e.step, status: e.status, remark: e.remark }),
          });
        }
        finally {
          await chrome.close();
        }
        ({ verdict, checks } = judge(cell, kane, config.dateOrder));
        const brokenSession = kane.exitCode === 2 || kane.exitCode === 3
          || /target(closed)?|page.{0,40}closed|closed unexpectedly|screenshot failed|crash/i.test(`${kane.runEnd?.summary || ''} ${kane.stderrTail}`);
        retry = verdict === 'unknown' && tries < maxTries && brokenSession
          && Object.keys(kane.finalState).filter(k => k !== 'url').length === 0;
        if (retry) log(`↻ ${cell.id}  no values recorded (${(kane.runEnd?.summary || kane.stderrTail || '').replace(/\s+/g, ' ').slice(0, 120)}), retrying`);
      } while (retry);
      const icon = { pass: '✓', fail: '✗', unknown: '?' }[verdict];
      log(`${icon} ${cell.id}  ${checks.map(c => c.reason || `${c.key} ok`).join('; ') || kane.stderrTail}`);
      const shotName = `cells/${safeId}.jpg`;
      const screenshot = extractScreenshot(kane.evidence, join(outDir, shotName)) ? shotName : null;
      results.push({
        id: cell.id,
        flow: cell.flow.id,
        flowName: cell.flow.name || cell.flow.id,
        clock: cell.clock,
        verdict,
        checks,
        tries,
        objective,
        kaneAgrees: kane.runEnd ? ((kane.runEnd.status === 'passed') === (verdict === 'pass')) : null,
        kane: {
          exitCode: kane.exitCode,
          status: kane.runEnd?.status ?? null,
          summary: kane.runEnd?.summary ?? null,
          credits: kane.runEnd?.credits_consumed ?? kane.runEnd?.credits ?? null,
          duration: kane.runEnd?.duration ?? Math.round((Date.now() - t0) / 1000),
          testUrl: kane.runEnd?.test_url ?? null,
          evidence: kane.evidence,
          screenshot,
          steps: kane.steps.map(s => ({ step: s.step, status: s.status, remark: s.remark })),
          ndjson: `cells/${safeId}${tries > 1 ? `.try${tries}` : ''}.ndjson`,
        },
      });
      emit('cell-done', results[results.length - 1]);
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
  out.evidence = await sealGrid(results, outDir, config, log);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2));
  return out;
}

function kaneCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn('kane-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

/** Merge every cell's Kane evidence pack into one sealed pack for the grid, then judge it against the policy. */
async function sealGrid(results, outDir, config, log) {
  const packs = results.map(r => r.kane.evidence).filter(Boolean);
  if (!packs.length) return null;
  const packPath = join(outDir, 'grid.evidence');
  const runId = `tzproof-${basename(outDir)}-${Date.now()}`;
  const merge = await kaneCli(['evidence', 'merge', ...packs, '--run-id', runId, '--title', `tzproof grid (${results.length} cells)`, '-o', packPath]);
  if (merge.code !== 0) {
    log(`evidence merge failed: ${merge.stderr.trim().split('\n').pop()}`);
    return { merged: false, packs: packs.length };
  }
  const policyPath = resolve(config.base, config.policy || join(TOOL_ROOT, 'policies/every-clock.yaml'));
  const judged = await kaneCli(['evidence', 'verdict', packPath, '--policy', policyPath]);
  const verdictLine = (judged.stdout + judged.stderr).split('\n').find(l => l.startsWith('verdict:')) || '';
  const status = judged.code === 0 ? 'pass' : judged.code === 1 ? 'fail' : 'errored';
  log(`kane policy (${basename(policyPath)}): ${verdictLine.replace(/^verdict:\s*/, '') || status}`);
  return { merged: true, pack: 'grid.evidence', packs: packs.length, runId, policy: basename(policyPath), policyVerdict: status, policyDetail: verdictLine.replace(/^verdict:\s*/, '') };
}
