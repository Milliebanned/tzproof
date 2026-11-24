// Claude Code Stop hook: when the agent tries to finish, run the tzproof grid. If any cell fails, block the stop and
// hand the agent Kane's evidence instead. After `maxAttempts` blocked stops in a row, let it stop and say so.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPrompt } from './loop.js';
import { renderReport } from './report.js';
import { runGrid } from './runner.js';

export async function runStopHook(config, { stdin, parallel = 2 }) {
  let input = {};
  try { input = JSON.parse(stdin || '{}'); }
  catch { /* not JSON: treat as a fresh stop */ }

  const stateDir = resolve(config.base, '.tzproof');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'hook-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { blocked: 0 };
  if (!input.stop_hook_active) state.blocked = 0;

  const outDir = join(stateDir, 'last-run');
  const results = await runGrid(config, { outDir, parallel, log: msg => process.stderr.write(`${msg}\n`) });
  writeFileSync(join(outDir, 'report.html'), renderReport(results));
  const { pass, fail, unknown } = results.summary;

  if (fail === 0) {
    writeFileSync(statePath, JSON.stringify({ blocked: 0 }));
    return { systemMessage: `tzproof: ${pass} pass · ${unknown} unknown across every clock and time zone. Report: ${join(outDir, 'report.html')}` };
  }

  const maxAttempts = config.fix?.maxAttempts || 3;
  if (state.blocked >= maxAttempts) {
    writeFileSync(statePath, JSON.stringify({ blocked: 0 }));
    return { systemMessage: `tzproof: still ${fail} failing cell(s) after ${maxAttempts} attempts. Stopping so a human can look. Report: ${join(outDir, 'report.html')}` };
  }

  writeFileSync(statePath, JSON.stringify({ blocked: state.blocked + 1 }));
  const editDir = resolve(config.base, config.fix?.edit || '.');
  return {
    decision: 'block',
    reason: buildPrompt(results, editDir, 'Do not edit tzproof.yaml or tests.'),
  };
}
