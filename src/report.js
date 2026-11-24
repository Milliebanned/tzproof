const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cellHtml(cell) {
  if (!cell) return '<td class="empty">–</td>';
  const label = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }[cell.verdict];
  const lines = cell.checks.map(c => c.status === 'pass'
    ? `<div>${esc(c.key)}: ${esc(c.shown)} ✓</div>`
    : `<div>${esc(c.key)}: ${esc(c.reason)}</div>`).join('');
  const links = [
    cell.kane.testUrl && `<a href="${esc(cell.kane.testUrl)}">Kane run ↗</a>`,
    `<a href="${esc(cell.kane.ndjson)}">NDJSON</a>`,
  ].filter(Boolean).join(' · ');
  const agree = cell.kaneAgrees === false
    ? `<div class="disagree">Kane's own check said ${cell.verdict === 'pass' ? 'FAIL' : 'PASS'}</div>` : '';
  const retried = cell.tries > 1 ? `<div>retried ${cell.tries - 1}× (browser session error)</div>` : '';
  return `<td class="${cell.verdict}"><strong>${label}</strong>${lines}${agree}${retried}<div class="links">${links}</div></td>`;
}

export function renderReport(results) {
  const byId = new Map(results.cells.map(c => [c.id, c]));
  const head = results.clocks.map(c => `<th>${esc(c.name || c.id)}<small>${esc(c.tz)}<br>${esc(c.at)}</small></th>`).join('');
  const rows = results.flows.map(f => `<tr><th class="flow">${esc(f.name)}</th>${
    results.clocks.map(c => cellHtml(byId.get(`${f.id}@${c.id}`))).join('')}</tr>`).join('');
  const { pass, fail, unknown } = results.summary;
  const credits = results.cells.reduce((sum, c) => sum + (Number(c.kane.credits) || 0), 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tzproof report</title>
<style>
  :root { --bg:#fff; --fg:#1b1b1f; --muted:#6b6b76; --line:#e4e4ea; --pass:#e7f6ec; --pass-fg:#156b35; --fail:#fdecec; --fail-fg:#a3201e; --unk:#f4f1e6; --unk-fg:#7a5c00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececf1; --muted:#9a9aa6; --line:#2c2c33; --pass:#11301d; --pass-fg:#7fdc9f; --fail:#3a1515; --fail-fg:#ff9a96; --unk:#332b12; --unk-fg:#f1cf6b; } }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
  h1 { font-size:22px; margin:0 0 4px; }
  .meta { color:var(--muted); margin-bottom:16px; }
  .totals span { display:inline-block; margin-right:14px; font-weight:600; }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; min-width:100%; }
  th, td { border:1px solid var(--line); padding:10px; vertical-align:top; text-align:left; }
  thead th { font-weight:600; }
  th small { display:block; color:var(--muted); font-weight:400; margin-top:2px; }
  th.flow { white-space:nowrap; }
  td strong { display:block; margin-bottom:4px; letter-spacing:.04em; font-size:12px; }
  td.pass { background:var(--pass); color:var(--pass-fg); }
  td.fail { background:var(--fail); color:var(--fail-fg); }
  td.unknown { background:var(--unk); color:var(--unk-fg); }
  .links { margin-top:6px; font-size:12px; }
  .links a { color:inherit; }
  .disagree { margin-top:6px; font-weight:600; text-decoration:underline dotted; }
  .note { color:var(--muted); margin-top:16px; max-width:70ch; }
</style>
</head>
<body>
<h1>tzproof report</h1>
<div class="meta">${esc(results.app)} · ${esc(results.startedAt)} · ${results.cells.length} cells · ${credits ? `${credits.toFixed(1)} Kane credits` : ''}</div>
${results.evidence?.merged ? `<div class="meta">Kane evidence: one sealed pack for the grid (<code>${esc(results.evidence.pack)}</code>, ${results.evidence.packs} runs) · policy <code>${esc(results.evidence.policy)}</code>: <strong>${esc(results.evidence.policyVerdict.toUpperCase())}</strong>${(results.evidence.policyDetail.match(/\(([^)]*)\)\s*$/) || [])[1] ? ` (failed gate: ${esc(results.evidence.policyDetail.match(/\(([^)]*)\)\s*$/)[1])})` : ''} · open with <code>kane-cli evidence serve ${esc(results.evidence.pack)}</code></div>` : ''}
<div class="totals"><span style="color:var(--pass-fg)">${pass} pass</span><span style="color:var(--fail-fg)">${fail} fail</span><span style="color:var(--unk-fg)">${unknown} unknown</span></div>
<div class="wrap"><table>
<thead><tr><th>Flow</th>${head}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="note">Kane CLI drives a real Chrome that believes it is at each clock and time zone, and records the dates the page shows.
tzproof computes the date the page should show and compares the two. Kane's own pass/fail is not the verdict: a cell passes only when every date matches, and a run that errors or records no value is UNKNOWN, never PASS.</p>
</body>
</html>
`;
}
