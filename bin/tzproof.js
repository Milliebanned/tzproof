#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderReport } from '../src/report.js';
import { loadConfig, planCells, runGrid } from '../src/runner.js';

const HELP = `tzproof — test your web app at every clock and time zone with Kane CLI

Usage:
  tzproof run [config]      Run every flow at every clock (default config: tzproof.yaml)
  tzproof plan [config]     List the cells a run would execute, without running them
  tzproof report <results>  Rebuild report.html from a results.json

Options for run:
  --out <dir>        Where to write results (default: tzproof-runs/<timestamp>)
  --parallel <n>     Cells at once (default: config "parallel" or 2)
  --only <text>      Only cells whose id contains this text (repeatable)
  --headed           Show the Chrome windows

Exit code: 0 all cells pass · 1 any cell fails · 2 no failures but some cells unknown
`;

function parseArgs(argv) {
  const args = { _: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--parallel') args.parallel = Number(argv[++i]);
    else if (a === '--only') args.only.push(argv[++i]);
    else if (a === '--headed') args.headed = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, target] = args._;
  if (args.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === 'plan') {
    const config = loadConfig(target || 'tzproof.yaml');
    for (const cell of planCells(config, { only: args.only.length ? args.only : undefined })) {
      console.log(`${cell.id}\t${cell.clock.tz}\t${cell.clock.at}`);
    }
    return 0;
  }

  if (command === 'run') {
    const config = loadConfig(target || 'tzproof.yaml');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = resolve(args.out || join('tzproof-runs', stamp));
    const results = await runGrid(config, {
      outDir,
      parallel: args.parallel || config.parallel || 2,
      headless: !args.headed,
      only: args.only.length ? args.only : undefined,
    });
    writeFileSync(join(outDir, 'report.html'), renderReport(results));
    const { pass, fail, unknown } = results.summary;
    console.log(`\n${pass} pass · ${fail} fail · ${unknown} unknown`);
    console.log(`report: ${join(outDir, 'report.html')}`);
    return fail ? 1 : unknown ? 2 : 0;
  }

  if (command === 'report') {
    if (!target) throw new Error('Usage: tzproof report <results.json>');
    const results = JSON.parse(readFileSync(target, 'utf8'));
    const out = join(dirname(resolve(target)), 'report.html');
    writeFileSync(out, renderReport(results));
    console.log(`report: ${out}`);
    return 0;
  }

  throw new Error(`Unknown command "${command}". Run "tzproof --help".`);
}

main().then(code => process.exit(code), (err) => {
  console.error(`tzproof: ${err.message}`);
  process.exit(2);
});
