// tzproof Studio: a local web app for building a grid, watching Kane run it live, and handing failures to the agent.
// Binds to 127.0.0.1 only. Runs are written under <workdir>/tzproof-runs/ like the CLI's.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { runLoop } from './loop.js';
import { renderReport } from './report.js';
import { loadConfig, planCells, runGrid } from './runner.js';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ndjson': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

export const CLOCK_PRESETS = [
  { id: 'new-york-afternoon', name: 'New York, afternoon', tz: 'America/New_York', at: '2026-06-15T18:00:00Z', why: 'A normal working day. The control.' },
  { id: 'tokyo-morning', name: 'Tokyo, 8:30 AM', tz: 'Asia/Tokyo', at: '2026-06-15T23:30:00Z', why: 'Already tomorrow in Tokyo, still today in UTC.' },
  { id: 'los-angeles-evening', name: 'Los Angeles, 9:30 PM', tz: 'America/Los_Angeles', at: '2026-06-16T04:30:00Z', why: 'Still today in LA, already tomorrow in UTC.' },
  { id: 'london-bst-midnight', name: 'London, 00:30 in summer', tz: 'Europe/London', at: '2026-04-09T23:30:00Z', why: 'UTC+1 only in summer. Fine in winter.' },
  { id: 'india-early', name: 'India, 2:00 AM', tz: 'Asia/Kolkata', at: '2026-06-14T20:30:00Z', why: 'A half-hour offset (UTC+5:30).' },
  { id: 'sydney-morning', name: 'Sydney, 7:00 AM', tz: 'Australia/Sydney', at: '2026-06-14T21:00:00Z', why: 'Southern hemisphere: winter in June.' },
  { id: 'auckland-new-year', name: 'Auckland, New Year’s Day', tz: 'Pacific/Auckland', at: '2026-12-31T18:00:00Z', why: 'First place in the new year (UTC+13).' },
  { id: 'honolulu-night', name: 'Honolulu, 10:00 PM', tz: 'Pacific/Honolulu', at: '2026-06-16T08:00:00Z', why: 'One of the last places to change day (UTC-10).' },
  { id: 'new-years-eve', name: 'New York, New Year’s Eve 11:30 PM', tz: 'America/New_York', at: '2027-01-01T04:30:00Z', why: 'Year boundary in local time, already next year in UTC.' },
  { id: 'month-end', name: 'New York, 31 January', tz: 'America/New_York', at: '2027-01-31T17:00:00Z', why: 'Add a month to Jan 31.' },
  { id: 'leap-day', name: 'Berlin, 29 February 2028', tz: 'Europe/Berlin', at: '2028-02-29T11:00:00Z', why: 'A day that exists one year in four.' },
  { id: 'dst-spring-forward', name: 'New York, DST starts', tz: 'America/New_York', at: '2027-03-14T07:30:00Z', why: 'The night 2 AM does not exist.' },
];

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolvePromise(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function kaneBalance() {
  return new Promise((resolvePromise) => {
    const child = spawn('kane-cli', ['balance'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolvePromise(Number(out.match(/credits:\s*([\d.]+)/i)?.[1]) || null));
    child.on('error', () => resolvePromise(null));
  });
}

export async function startStudio({ configPath, port = 4321, workdir = process.cwd() }) {
  const runsRoot = resolve(workdir, 'tzproof-runs');
  const jobs = new Map();   // id -> { events: [], clients: Set, status, dir, config, results }
  const viewers = new Map(); // pack path -> viewer url

  let base = configPath ? loadConfig(configPath) : null;

  function newJob(kind, config) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `studio-${kind}-${stamp}`;
    const job = { id, kind, events: [], clients: new Set(), status: 'running', dir: join(runsRoot, id), config };
    jobs.set(id, job);
    return job;
  }

  function emitter(job) {
    return (type, data) => {
      const event = { type, data, t: Date.now() };
      job.events.push(event);
      for (const res of job.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
  }

  function configFromBody(body) {
    if (!body.app && !body.serve) throw new Error('Enter your app’s URL.');
    if (!body.clocks?.length) throw new Error('Pick at least one clock.');
    if (!body.flows?.length) throw new Error('Add at least one check.');
    return {
      base: base?.base || workdir,
      app: body.app || undefined,
      serve: body.serve || undefined,
      dateOrder: body.dateOrder || 'mdy',
      clocks: body.clocks,
      flows: body.flows,
      secrets: base?.secrets,
      fix: body.fixEdit ? { edit: body.fixEdit, maxAttempts: 3 } : base?.fix,
      policy: base?.policy,
      kaneAssert: body.kaneAssert !== false,
    };
  }

  async function startRun(body) {
    const config = configFromBody(body);
    const job = newJob('run', config);
    const emit = emitter(job);
    emit('grid-start', { name: 'run', cells: planCells(config).map(c => c.id) });
    mkdirSync(runsRoot, { recursive: true });
    runGrid(config, { outDir: job.dir, parallel: Number(body.parallel) || 2, log: () => {}, emit })
      .then((results) => {
        writeFileSync(join(job.dir, 'report.html'), renderReport(results));
        writeFileSync(join(job.dir, 'tzproof.yaml'), toYaml(stripForYaml(config)));
        job.results = results;
        job.status = 'done';
        emit('grid-done', { name: 'run', summary: results.summary, evidence: results.evidence, dir: job.id });
        emit('end', { ok: true });
      })
      .catch((err) => { job.status = 'error'; emit('end', { ok: false, error: err.message }); });
    return job;
  }

  async function startFix(body) {
    const from = jobs.get(body.runId);
    if (!from?.results) throw new Error('Run the grid first.');
    const config = { ...from.config, ...(body.fixEdit ? { fix: { edit: body.fixEdit, maxAttempts: 3 } } : {}) };
    if (!config.fix?.edit) throw new Error('Choose the folder Claude may edit.');
    if (!existsSync(resolve(config.base, config.fix.edit))) throw new Error(`Folder not found: ${resolve(config.base, config.fix.edit)}`);
    const job = newJob('fix', config);
    const emit = emitter(job);
    runLoop(config, {
      outDir: job.dir, parallel: Number(body.parallel) || 2, log: () => {}, emit,
      startFrom: { dir: from.id, results: from.results },
    })
      .then((loop) => { job.status = 'done'; job.loop = loop; emit('end', { ok: true, status: loop.status }); })
      .catch((err) => { job.status = 'error'; emit('end', { ok: false, error: err.message }); });
    return job;
  }

  function serveEvidence(pack) {
    if (viewers.has(pack)) return Promise.resolve(viewers.get(pack));
    return new Promise((resolvePromise, reject) => {
      const child = spawn('kane-cli', ['evidence', 'serve', pack], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const onData = (d) => {
        out += d;
        const url = out.match(/viewer\s+(https?:\/\/\S+)/)?.[1];
        if (url) { viewers.set(pack, url); resolvePromise(url); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', () => reject(new Error(out.trim().split('\n').pop() || 'kane-cli evidence serve exited')));
      setTimeout(() => reject(new Error('Kane evidence viewer did not start')), 15000);
    });
  }

  function listRuns() {
    if (!existsSync(runsRoot)) return [];
    return readdirSync(runsRoot)
      .filter(d => existsSync(join(runsRoot, d, 'results.json')))
      .map((d) => {
        const r = JSON.parse(readFileSync(join(runsRoot, d, 'results.json'), 'utf8'));
        return { id: d, startedAt: r.startedAt, summary: r.summary, cells: r.cells.length };
      })
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, 20);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        return send(res, 200, {
          presets: CLOCK_PRESETS,
          config: base && {
            app: base.app, serve: base.serve, dateOrder: base.dateOrder, clocks: base.clocks, flows: base.flows,
            fixEdit: base.fix?.edit || null, base: base.base,
          },
          balance: await kaneBalance(),
          runs: listRuns(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const job = await startRun(await readBody(req));
        return send(res, 200, { id: job.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/fix') {
        const job = await startFix(await readBody(req));
        return send(res, 200, { id: job.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/evidence') {
        const body = await readBody(req);
        const pack = body.rel ? normalize(join(runsRoot, body.rel)) : body.pack;
        if (body.rel && !pack.startsWith(runsRoot)) return send(res, 400, { error: 'Bad path.' });
        if (!pack || !pack.endsWith('.evidence') || !existsSync(pack)) return send(res, 400, { error: 'No evidence pack for this cell.' });
        return send(res, 200, { url: await serveEvidence(pack) });
      }
      if (req.method === 'GET' && url.pathname === '/api/balance') return send(res, 200, { balance: await kaneBalance() });
      const events = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/);
      if (req.method === 'GET' && events) {
        const job = jobs.get(events[1]);
        if (!job) return send(res, 404, { error: 'unknown job' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        job.clients.add(res);
        req.on('close', () => job.clients.delete(res));
        return undefined;
      }
      // Files from runs (reports, screenshots, NDJSON, diffs)
      if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
        const file = normalize(join(runsRoot, decodeURIComponent(url.pathname.slice('/runs/'.length))));
        if (!file.startsWith(runsRoot) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream');
      }
      // The Studio UI
      const file = normalize(join(UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (file.startsWith(UI_DIR) && existsSync(file) && !statSync(file).isDirectory()) {
        return send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, 'not found', 'text/plain');
    }
    catch (err) {
      return send(res, 400, { error: err.message });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function stripForYaml(config) {
  const { base, ...rest } = config;
  return JSON.parse(JSON.stringify(rest));
}
