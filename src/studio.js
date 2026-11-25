// tzproof Studio: a web app to build a grid, watch Kane run it live, open each cell's evidence, and fix with Claude.
//
// Local:  tzproof ui [config]                → http://127.0.0.1:4321, your own app, your own folders.
// Hosted: TZPROOF_PUBLIC=1 tzproof ui         → anyone can test a public website. Guard rails: public addresses only,
//         at most MAX_CELLS cells per run, one run at a time (queued), runs per visitor per hour, a daily credit cap.
//         "Fix with Claude" runs live only on the built-in demo app (each visitor gets a private copy), and only
//         when ANTHROPIC_API_KEY is set, up to a daily number of fixes.
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { buildPrompt, runLoop } from './loop.js';
import { renderReport } from './report.js';
import { loadConfig, planCells, runGrid } from './runner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'ui');
const DEMO_APP = join(ROOT, 'examples/fix-loop/app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ndjson': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.evidence': 'application/zip', '.ico': 'image/x-icon',
};

export const CLOCK_PRESETS = [
  { id: 'new-york-afternoon', name: 'New York', when: 'afternoon', tz: 'America/New_York', at: '2026-06-15T18:00:00Z', why: 'A normal working day. The control.' },
  { id: 'tokyo-morning', name: 'Tokyo', when: '8:30 AM', tz: 'Asia/Tokyo', at: '2026-06-15T23:30:00Z', why: 'Already tomorrow in Tokyo, still today in UTC.' },
  { id: 'los-angeles-evening', name: 'Los Angeles', when: '9:30 PM', tz: 'America/Los_Angeles', at: '2026-06-16T04:30:00Z', why: 'Still today in LA, already tomorrow in UTC.' },
  { id: 'london-bst-midnight', name: 'London', when: '00:30, summer', tz: 'Europe/London', at: '2026-04-09T23:30:00Z', why: 'UTC+1 only in summer. Fine all winter.' },
  { id: 'india-early', name: 'India', when: '2:00 AM', tz: 'Asia/Kolkata', at: '2026-06-14T20:30:00Z', why: 'A half-hour offset (UTC+5:30).' },
  { id: 'sydney-morning', name: 'Sydney', when: '7:00 AM', tz: 'Australia/Sydney', at: '2026-06-14T21:00:00Z', why: 'Southern hemisphere: winter in June.' },
  { id: 'auckland-new-year', name: 'Auckland', when: 'New Year’s Day', tz: 'Pacific/Auckland', at: '2026-12-31T18:00:00Z', why: 'First place in the new year (UTC+13).' },
  { id: 'honolulu-night', name: 'Honolulu', when: '10:00 PM', tz: 'Pacific/Honolulu', at: '2026-06-16T08:00:00Z', why: 'One of the last places to change day (UTC-10).' },
  { id: 'new-years-eve', name: 'New York', when: 'New Year’s Eve', tz: 'America/New_York', at: '2027-01-01T04:30:00Z', why: 'Still this year locally, already next year in UTC.' },
  { id: 'month-end', name: 'New York', when: '31 January', tz: 'America/New_York', at: '2027-01-31T17:00:00Z', why: 'Add a month to Jan 31.' },
  { id: 'leap-day', name: 'Berlin', when: '29 Feb 2028', tz: 'Europe/Berlin', at: '2028-02-29T11:00:00Z', why: 'A day that exists one year in four.' },
  { id: 'dst-spring-forward', name: 'New York', when: 'DST starts', tz: 'America/New_York', at: '2027-03-14T07:30:00Z', why: 'The night 2 AM does not exist.' },
];

const DEMO_FLOW = {
  id: 'account', name: 'Account dates',
  objective: "Go to {{app}}. Store the text shown next to 'Today' as 'today', the text shown next to 'Trial ends' as 'trial_end', and the text shown next to 'Next invoice' as 'next_invoice'.",
  expect: { today: 'today', trial_end: 'today+14d', next_invoice: 'today+1mo' },
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200_000) req.destroy(); });
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

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Only public http(s) websites may be tested from the hosted version. */
export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('That is not a web address. Try https://your-site.com'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('This hosted version can only test public websites. Run tzproof yourself to test localhost.');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`Could not find ${host}.`);
  if (addresses.some(a => isPrivateAddress(a.address))) throw new Error('This hosted version can only test public websites. Run tzproof yourself to test a private network.');
  return url.toString();
}

export async function startStudio({ configPath, port = 4321, host = '127.0.0.1', workdir = process.cwd() } = {}) {
  const publicMode = process.env.TZPROOF_PUBLIC === '1';
  const dataDir = resolve(process.env.TZPROOF_DATA || workdir);
  const runsRoot = join(dataDir, 'tzproof-runs');
  mkdirSync(runsRoot, { recursive: true });
  const limits = {
    maxCells: Number(process.env.TZPROOF_MAX_CELLS || (publicMode ? 6 : 60)),
    runsPerHour: Number(process.env.TZPROOF_RUNS_PER_HOUR || (publicMode ? 4 : 1000)),
    dailyCredits: Number(process.env.TZPROOF_DAILY_CREDITS || (publicMode ? 1500 : 1e9)),
    dailyFixes: Number(process.env.TZPROOF_DAILY_FIXES || (publicMode ? 15 : 1e9)),
  };
  // Who fixes: Claude Code if an Anthropic key is set (or always, locally), otherwise Gemini if a Gemini key is set.
  const fixAgent = !publicMode || process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.GEMINI_API_KEY ? 'gemini' : null;
  const fixAgentName = fixAgent === 'gemini' ? 'Gemini' : 'Claude';
  const liveFix = !!fixAgent;
  const internalBase = `http://127.0.0.1:${port}`;

  const jobs = new Map();
  const queue = [];
  let busy = false;
  const viewers = new Map();
  const visits = new Map(); // ip -> [timestamps]
  const base = configPath ? loadConfig(configPath) : null;

  const usagePath = join(dataDir, 'usage.json');
  const today = () => new Date().toISOString().slice(0, 10);
  function usage() {
    const u = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) : {};
    return u.day === today() ? u : { day: today(), credits: 0, fixes: 0, runs: 0 };
  }
  function addUsage(delta) {
    const u = usage();
    for (const [k, v] of Object.entries(delta)) u[k] = (u[k] || 0) + v;
    writeFileSync(usagePath, JSON.stringify(u));
  }

  function newJob(kind, config, extra = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `${kind}-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
    const job = { id, kind, events: [], clients: new Set(), status: 'queued', dir: join(runsRoot, id), config, ...extra };
    mkdirSync(job.dir, { recursive: true });
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

  function enqueue(job, work) {
    queue.push({ job, work });
    const emit = emitter(job);
    emit('queued', { position: queue.length + (busy ? 1 : 0) - 1 });
    pump();
  }

  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const { job, work } = queue.shift();
    queue.forEach((q, i) => emitter(q.job)('queued', { position: i + 1 }));
    job.status = 'running';
    try { await work(); }
    catch (err) { job.status = 'error'; emitter(job)('end', { ok: false, error: err.message }); }
    busy = false;
    pump();
  }

  function rateCheck(ip) {
    const now = Date.now();
    const recent = (visits.get(ip) || []).filter(t => now - t < 3_600_000);
    if (recent.length >= limits.runsPerHour) throw new Error(`You have used your ${limits.runsPerHour} runs for this hour. Try again later, or install tzproof to run it yourself.`);
    recent.push(now);
    visits.set(ip, recent);
  }

  function saveMeta(job, extra = {}) {
    writeFileSync(join(job.dir, 'job.json'), JSON.stringify({
      id: job.id, kind: job.kind, demo: !!job.demo, from: job.from || null, createdAt: new Date().toISOString(),
      clocks: job.config.clocks, flows: job.config.flows.map(f => ({ id: f.id, name: f.name || f.id })), app: job.publicApp || job.config.app || null, ...extra,
    }, null, 2));
  }

  async function startRun(body, ip) {
    if (body.demo) body.flows = [DEMO_FLOW];
    if (!body.clocks?.length) throw new Error('Pick at least one place and time.');
    if (!body.flows?.length) throw new Error('Add at least one date to check.');
    for (const f of body.flows) {
      if (!f.objective?.trim()) throw new Error('Tell Kane what to do on the page.');
      if (!f.expect || !Object.keys(f.expect).length) throw new Error('Each check needs at least one date to compare.');
    }
    const cells = body.clocks.length * body.flows.length;
    if (cells > limits.maxCells) throw new Error(`At most ${limits.maxCells} cells per run here (you picked ${cells}). Remove a clock or a check.`);
    if (publicMode) {
      if (usage().credits >= limits.dailyCredits) throw new Error('Today’s free Kane credits for the hosted version are used up. Install tzproof to run it with your own Kane account.');
      rateCheck(ip);
    }

    const demo = !!body.demo;
    const config = {
      base: base?.base || workdir,
      dateOrder: body.dateOrder === 'dmy' ? 'dmy' : 'mdy',
      clocks: body.clocks.map(c => ({ id: String(c.id).replace(/[^\w-]/g, '-'), name: c.name, when: c.when, tz: c.tz, at: c.at })),
      flows: body.flows.map((f, i) => ({ id: String(f.id || `check-${i + 1}`).replace(/[^\w-]/g, '-'), name: f.name, objective: String(f.objective).slice(0, 1500), expect: f.expect })),
      secrets: publicMode ? undefined : base?.secrets,
      policy: base?.policy,
      kaneAssert: body.kaneAssert !== false,
    };
    for (const c of config.clocks) {
      try { new Intl.DateTimeFormat('en', { timeZone: c.tz }); }
      catch { throw new Error(`"${c.tz}" is not a time zone.`); }
      if (Number.isNaN(Date.parse(c.at))) throw new Error(`"${c.at}" is not a date and time.`);
    }

    const job = newJob('run', config, { demo });
    if (demo) {
      cpSync(DEMO_APP, join(job.dir, 'app'), { recursive: true });
      config.app = `${internalBase}/demo/${job.id}/`;
      config.fix = { edit: join(job.dir, 'app'), maxAttempts: 2, ...(fixAgent === 'gemini' ? { agent: 'gemini' } : {}) };
      config.flows = [DEMO_FLOW];
      job.publicApp = 'tzproof demo billing page';
    }
    else if (publicMode) {
      config.app = await assertPublicUrl(String(body.app || ''));
    }
    else if (body.app) {
      config.app = body.app;
    }
    else if (base?.serve) {
      config.serve = base.serve;
      config.fix = base.fix;
    }
    else {
      throw new Error('Enter your website’s address.');
    }
    if (!publicMode && body.fixEdit) config.fix = { edit: body.fixEdit, maxAttempts: 3 };
    saveMeta(job);
    writeFileSync(join(job.dir, 'config.json'), JSON.stringify({ ...config, secrets: undefined }, null, 2));

    const emit = emitter(job);
    enqueue(job, async () => {
      emit('grid-start', { name: 'run', cells: planCells(config).map(c => c.id) });
      const results = await runGrid(config, { outDir: job.dir, parallel: publicMode ? 2 : Number(body.parallel) || 2, log: () => {}, emit });
      writeFileSync(join(job.dir, 'report.html'), renderReport(results));
      writeFileSync(join(job.dir, 'tzproof.yaml'), toYaml(stripForYaml(config)));
      const credits = results.cells.reduce((s, c) => s + (Number(c.kane.credits) || 0), 0);
      addUsage({ credits, runs: 1 });
      job.results = results;
      job.status = 'done';
      emit('grid-done', { name: 'run', summary: results.summary, evidence: results.evidence, credits });
      emit('end', { ok: true });
    });
    return job;
  }

  /** A finished run, from memory or (after a restart) from disk. */
  function loadRun(id) {
    if (jobs.get(id)?.results) return jobs.get(id);
    const dir = join(runsRoot, String(id));
    if (!/^[\w-]+$/.test(String(id)) || !existsSync(join(dir, 'results.json')) || !existsSync(join(dir, 'config.json'))) return null;
    const meta = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
    const job = {
      id, kind: 'run', events: [], clients: new Set(), status: 'done', dir, demo: meta.demo, publicApp: meta.app,
      config: JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')),
      results: JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')),
    };
    if (job.demo) job.config.app = `${internalBase}/demo/${id}/`;
    jobs.set(id, job);
    return job;
  }

  async function startFix(body) {
    const from = loadRun(body.runId);
    if (!from?.results) throw new Error('Run the grid first.');
    if (publicMode && !from.demo) throw new Error('Here, Claude can only fix the demo app. For your own site, copy the prompt into Claude Code in your repo.');
    if (!liveFix) throw new Error('Live fixes are off on this server. Copy the prompt into Claude Code in your repo.');
    if (publicMode && usage().fixes >= limits.dailyFixes) throw new Error('Today’s live fixes are used up. Copy the prompt into Claude Code instead.');
    const config = { ...from.config };
    if (!publicMode && body.fixEdit) config.fix = { edit: body.fixEdit, maxAttempts: 3 };
    if (!config.fix?.edit) throw new Error('Choose the folder Claude may edit.');
    if (!existsSync(resolve(config.base, config.fix.edit))) throw new Error(`Folder not found: ${resolve(config.base, config.fix.edit)}`);
    const job = newJob('fix', config, { demo: from.demo, from: from.id, publicApp: from.publicApp });
    saveMeta(job);
    if (publicMode) addUsage({ fixes: 1 });
    const emit = emitter(job);
    enqueue(job, async () => {
      const loop = await runLoop(config, {
        outDir: job.dir, parallel: 2, log: () => {}, emit,
        maxAttempts: config.fix.maxAttempts || 3,
        startFrom: { dir: from.id, results: from.results },
      });
      job.status = 'done';
      emit('end', { ok: true, status: loop.status });
    });
    return job;
  }

  function serveEvidenceLocally(pack) {
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

  function savedRun(id) {
    const dir = join(runsRoot, id);
    if (!/^[\w-]+$/.test(id) || !existsSync(join(dir, 'job.json'))) return null;
    const meta = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
    const out = { meta, results: null, loop: null };
    if (existsSync(join(dir, 'results.json'))) out.results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    if (existsSync(join(dir, 'loop.json'))) {
      out.loop = JSON.parse(readFileSync(join(dir, 'loop.json'), 'utf8'));
      out.grids = out.loop.attempts.filter(a => a.run && a.attempt > 0).map(a => ({
        name: a.run, attempt: a.attempt,
        results: JSON.parse(readFileSync(join(dir, a.run, 'results.json'), 'utf8')),
      }));
      out.loop.attempts = out.loop.attempts.map(a => ({ ...a, diffText: a.diff && existsSync(join(dir, a.diff)) ? readFileSync(join(dir, a.diff), 'utf8') : '' }));
    }
    return out;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    try {
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        return send(res, 200, {
          publicMode, liveFix, fixAgentName, limits,
          presets: CLOCK_PRESETS,
          demoFlow: DEMO_FLOW,
          config: !publicMode && base ? {
            app: base.app, serve: base.serve, dateOrder: base.dateOrder, clocks: base.clocks, flows: base.flows, fixEdit: base.fix?.edit || null,
          } : null,
          today: publicMode ? { creditsLeft: Math.max(0, Math.round(limits.dailyCredits - usage().credits)) } : null,
          queue: queue.length + (busy ? 1 : 0),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') return send(res, 200, { id: (await startRun(await readBody(req), ip)).id });
      if (req.method === 'POST' && url.pathname === '/api/fix') return send(res, 200, { id: (await startFix(await readBody(req))).id });
      if (req.method === 'POST' && url.pathname === '/api/evidence') {
        const body = await readBody(req);
        const pack = normalize(join(runsRoot, String(body.rel || '')));
        if (!pack.startsWith(runsRoot) || !pack.endsWith('.evidence') || !existsSync(pack)) return send(res, 400, { error: 'No evidence pack here.' });
        if (publicMode) {
          const origin = `https://${req.headers.host}`;
          return send(res, 200, { url: `https://evidence.lambdatest.com/?pack=${encodeURIComponent(`${origin}/runs/${body.rel}`)}` });
        }
        return send(res, 200, { url: await serveEvidenceLocally(pack) });
      }
      const promptMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/prompt$/);
      if (req.method === 'GET' && promptMatch) {
        const saved = savedRun(promptMatch[1]);
        if (!saved?.results) return send(res, 404, { error: 'unknown run' });
        return send(res, 200, buildPrompt(saved.results, 'your app’s source folder', 'Do not edit tests or the tzproof config.'), 'text/plain; charset=utf-8');
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === 'GET' && runMatch) {
        const saved = savedRun(runMatch[1]);
        if (!saved) return send(res, 404, { error: 'This run does not exist (or this server was reset).' });
        const live = jobs.get(runMatch[1]);
        return send(res, 200, { ...saved, live: live ? live.status : 'done' });
      }
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
      // The demo billing page: each run gets its own copy, so a fix for one visitor doesn't touch anyone else's.
      const demo = url.pathname.match(/^\/demo\/([\w-]+)\/?(.*)$/);
      if (req.method === 'GET' && demo) {
        const dir = join(runsRoot, demo[1], 'app');
        const file = normalize(join(dir, demo[2] || 'index.html'));
        if (!file.startsWith(dir) || !existsSync(file)) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, readFileSync(file), MIME[extname(file)] || 'text/plain');
      }
      if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
        const file = normalize(join(runsRoot, decodeURIComponent(url.pathname.slice('/runs/'.length))));
        if (!file.startsWith(runsRoot) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream', { 'access-control-allow-origin': '*' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      // UI (and /r/<id> share links, which the UI reads from the path)
      const path = url.pathname === '/' ? 'landing.html' : url.pathname === '/app' || url.pathname.startsWith('/r/') ? 'index.html' : url.pathname;
      const file = normalize(join(UI_DIR, path));
      if (file.startsWith(UI_DIR) && existsSync(file) && !statSync(file).isDirectory()) {
        return send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, 'not found', 'text/plain');
    }
    catch (err) {
      return send(res, 400, { error: err.message });
    }
  });

  await new Promise(r => server.listen(port, host, r));
  return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, close: () => server.close(), publicMode };
}

function stripForYaml(config) {
  const { base, secrets, ...rest } = config;
  return JSON.parse(JSON.stringify(rest));
}
