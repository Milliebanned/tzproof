// The closed loop: run the grid, hand failing cells (with Kane's evidence) to a coding agent that may only edit
// the app, check it didn't touch anything else, re-run the whole grid, repeat until green or out of attempts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runGeminiFixer } from './gemini.js';
import { renderReport } from './report.js';
import { planCells, runGrid } from './runner.js';

const SKIP = new Set(['node_modules', '.git', 'tzproof-runs']);

function listFiles(root, base = root, out = []) {
  for (const name of readdirSync(root)) {
    if (SKIP.has(name)) continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

/** Snapshot of every protected file (outside the agent's folder): its hash and, for restoring, its bytes. */
function snapshotTree(root, exclude) {
  const files = new Map();
  for (const file of listFiles(root)) {
    const full = join(root, file);
    if (exclude.some(ex => full === ex || full.startsWith(`${ex}/`))) continue;
    const bytes = readFileSync(full);
    files.set(file, { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length <= 2_000_000 ? bytes : null });
  }
  return files;
}

function localTime(at, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(at));
}

export function buildPrompt(results, editDir, protectedNote) {
  const failing = results.cells.filter(c => c.verdict === 'fail');
  const passing = results.cells.filter(c => c.verdict === 'pass');
  const describe = c => [
    `- ${c.id} — ${c.clock.tz}, the user's clock reads ${localTime(c.clock.at, c.clock.tz)}`,
    ...c.checks.filter(k => k.status === 'fail').map(k => `    • "${k.key}" ${k.reason} (raw text on the page: "${k.shownRaw}")`),
    c.kane.summary ? `    • Kane CLI's own summary of the run: ${c.kane.summary.replace(/\s+/g, ' ').slice(0, 400)}` : null,
  ].filter(Boolean).join('\n');

  return `You are fixing date and time-zone bugs in a web app.

tzproof ran the app in a real Chrome browser, driven by Kane CLI, at several clocks and time zones. For each one it read the
dates the page displayed and compared them with the correct calendar dates for a user at that place and time.

FAILING (fix these):
${failing.map(describe).join('\n')}

PASSING (these must keep passing):
${passing.map(c => `- ${c.id} — ${c.clock.tz}, ${localTime(c.clock.at, c.clock.tz)}`).join('\n') || '- none'}

Rules:
- Only edit files inside ${editDir}. ${protectedNote}
- Fix the root cause so the dates are right for any user, in any time zone, on any date. Do not special-case these
  particular time zones, dates or cells, and do not change what a date means (a 14-day trial stays 14 days).
- Keep the page's labels and layout. You may change how a date is formatted as long as it stays a full, unambiguous date.
- You cannot run the app or the tests; tzproof will re-run every cell after you finish.

When you are done, reply with two short lines: "Root cause: …" and "Fix: …".`;
}

function runAgent(prompt, cwd, agentCmd) {
  return new Promise((resolvePromise) => {
    const [cmd, ...args] = agentCmd;
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let text = stdout.trim();
      let cost = null;
      try {
        const parsed = JSON.parse(stdout);
        text = parsed.result ?? text;
        cost = parsed.total_cost_usd ?? null;
      }
      catch { /* agent printed plain text */ }
      resolvePromise({ code, text, cost, stderr: stderr.trim().slice(-500) });
    });
    child.stdin.end(prompt);
  });
}

const DEFAULT_AGENT = ['claude', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Read,Edit,Write,Glob,Grep'];

/**
 * @returns {Promise<{ status: 'green' | 'handed-to-human', attempts: object[] }>}
 */
export async function runLoop(config, { outDir, parallel, headless = true, maxAttempts = 3, log = console.log, emit = () => {}, startFrom = null }) {
  if (!config.fix?.edit) throw new Error('Add a "fix" section to the config: fix: { edit: ./path/the/agent/may/change }');
  const editDir = resolve(config.base, config.fix.edit);
  const agentCmd = config.fix.agent && config.fix.agent !== 'gemini' ? String(config.fix.agent).split(' ') : DEFAULT_AGENT;
  const protectedRoot = config.base;
  const protectedNote = 'Do not edit tzproof.yaml, tests, or anything outside that folder: those files are checked, and an attempt that changes them is rejected and undone.';
  mkdirSync(outDir, { recursive: true });

  const attempts = [];
  const grid = async (name) => {
    const dir = join(outDir, name);
    emit('grid-start', { name, cells: planCells(config).map(c => c.id) });
    const results = await runGrid(config, { outDir: dir, parallel, headless, log, emit });
    emit('grid-done', { name, summary: results.summary, evidence: results.evidence });
    writeFileSync(join(dir, 'report.html'), renderReport(results));
    return { dir: name, results };
  };

  let current;
  if (startFrom) {
    current = { dir: startFrom.dir, results: startFrom.results };
  }
  else {
    log('\n=== baseline run ===');
    current = await grid('0-baseline');
  }
  attempts.push({ attempt: 0, run: current.dir, summary: current.results.summary });

  for (let n = 1; n <= maxAttempts && current.results.summary.fail > 0; n++) {
    log(`\n=== attempt ${n}: handing ${current.results.summary.fail} failing cell(s) to the agent ===`);
    const before = join(outDir, `.snapshot-${n}`);
    cpSync(editDir, before, { recursive: true });
    const guardBefore = snapshotTree(protectedRoot, [editDir, outDir]);

    const prompt = buildPrompt(current.results, editDir, protectedNote);
    writeFileSync(join(outDir, `attempt-${n}-prompt.md`), prompt);
    emit('agent-start', { attempt: n, failing: current.results.summary.fail, agent: config.fix.agent === 'gemini' ? 'Gemini' : 'Claude Code' });
    const agent = config.fix.agent === 'gemini' ? await runGeminiFixer(prompt, editDir) : await runAgent(prompt, editDir, agentCmd);
    log(`agent: ${agent.text.replace(/\s+/g, ' ').slice(0, 300)}`);

    // Guard: anything outside the app folder that changed is restored and the attempt is rejected.
    const guardAfter = snapshotTree(protectedRoot, [editDir, outDir]);
    const tampered = [...new Set([...guardBefore.keys(), ...guardAfter.keys()])]
      .filter(f => guardBefore.get(f)?.hash !== guardAfter.get(f)?.hash);

    const diff = spawnSync('git', ['diff', '--no-index', '--no-color', before, editDir], { encoding: 'utf8' }).stdout
      .replaceAll(`a${before}`, 'a').replaceAll(`b${editDir}`, 'b').replaceAll(before, '').replaceAll(editDir, '');
    writeFileSync(join(outDir, `attempt-${n}.diff`), diff);

    emit('agent-done', { attempt: n, agent: config.fix.agent === 'gemini' ? 'Gemini' : 'Claude Code', text: agent.text, cost: agent.cost, diff, rejected: tampered.length > 0, tampered });
    if (tampered.length) {
      log(`✗ rejected: the agent changed protected files: ${tampered.join(', ')}`);
      // Put each file back exactly as it was before this attempt (never from git: that would also drop
      // a developer's own uncommitted work).
      for (const file of tampered) {
        const was = guardBefore.get(file);
        const full = join(protectedRoot, file);
        if (!was) rmSync(full, { force: true });
        else if (was.bytes) writeFileSync(full, was.bytes);
      }
      rmSync(editDir, { recursive: true, force: true });
      cpSync(before, editDir, { recursive: true });
      attempts.push({ attempt: n, rejected: true, tampered, agent: agent.text, agentCost: agent.cost, diff: `attempt-${n}.diff` });
      rmSync(before, { recursive: true, force: true });
      continue;
    }
    rmSync(before, { recursive: true, force: true });

    // Nothing changed (the fixer failed or gave up): re-running every clock would only spend credits.
    if (!diff.trim()) {
      log(`attempt ${n} changed nothing: not re-running the grid`);
      attempts.push({ attempt: n, agent: agent.text, agentCost: agent.cost, diff: `attempt-${n}.diff`, prompt: `attempt-${n}-prompt.md`, unchanged: true });
      emit('grid-skip', { attempt: n });
      break;
    }

    log(`\n=== re-running the whole grid after attempt ${n} ===`);
    current = await grid(`${n}-after-fix`);
    attempts.push({
      attempt: n, agent: agent.text, agentCost: agent.cost, diff: `attempt-${n}.diff`, prompt: `attempt-${n}-prompt.md`,
      run: current.dir, summary: current.results.summary,
    });
  }

  const status = current.results.summary.fail === 0 && current.results.summary.unknown === 0 ? 'green' : 'handed-to-human';
  const loop = { tool: 'tzproof', status, maxAttempts, attempts, finishedAt: new Date().toISOString() };
  writeFileSync(join(outDir, 'loop.json'), JSON.stringify(loop, null, 2));
  writeFileSync(join(outDir, 'LOOP.md'), renderLoopMarkdown(loop));
  return loop;
}

function renderLoopMarkdown(loop) {
  const lines = [`# tzproof fix loop — ${loop.status === 'green' ? '✅ green' : '⚠️ handed to a human'}`, ''];
  for (const a of loop.attempts) {
    if (a.attempt === 0) {
      lines.push(`## Baseline`, `${a.summary.pass} pass · ${a.summary.fail} fail · ${a.summary.unknown} unknown — [report](${a.run}/report.html)`, '');
      continue;
    }
    lines.push(`## Attempt ${a.attempt}`);
    if (a.agent) lines.push('', '**Agent:**', '', '> ' + a.agent.trim().replace(/\n/g, '\n> '));
    lines.push('', `[prompt](${a.prompt || '#'}) · [diff](${a.diff})`);
    if (a.unchanged) lines.push('', 'No change was made, so the grid was not re-run.');
    else if (a.rejected) lines.push('', `**Rejected:** changed protected files (${a.tampered.join(', ')}). Changes undone.`);
    else lines.push('', `Re-run: ${a.summary.pass} pass · ${a.summary.fail} fail · ${a.summary.unknown} unknown — [report](${a.run}/report.html)`);
    lines.push('');
  }
  return lines.join('\n');
}

