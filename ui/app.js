const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const RULES = [
  ['today', 'today'], ['today+1d', 'tomorrow'], ['today-1d', 'yesterday'], ['today+3d', 'today + 3 days'],
  ['today+7d', 'today + 7 days'], ['today+14d', 'today + 14 days'], ['today+30d', 'today + 30 days'],
  ['today+1mo', 'today + 1 month'], ['today+1y', 'today + 1 year'],
];
const SUGGEST = [
  ['the delivery date at checkout', 'today+3d'], ['when my free trial ends', 'today+14d'], ['the date on today’s invoice', 'today'],
  ['the next billing date', 'today+1mo'], ['the due date on a new task', 'today+7d'],
];
const DEFAULT_CLOCKS = ['new-york-afternoon', 'tokyo-morning', 'los-angeles-evening', 'london-bst-midnight', 'month-end'];

const state = {
  setup: null, demo: false, selected: new Set(DEFAULT_CLOCKS), panelOpen: false,
  runId: null, grids: new Map(), activeGrid: null, source: null,
};

/* ---------- helpers ---------- */
const fmtTime = (clock, opts) => new Intl.DateTimeFormat('en-US', { timeZone: clock.tz, ...opts }).format(new Date(clock.at));
const whenText = c => fmtTime(c, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
}
function showError(sel, msg) { const el = $(sel); el.textContent = msg || ''; el.hidden = !msg; }
function clocks() { return state.setup.presets.filter(p => state.selected.has(p.id)); }

/* ---------- composer ---------- */
function renderRules(value = 'today+3d') {
  $('#rule').innerHTML = RULES.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('');
}
function renderChips() {
  const chosen = clocks();
  $('#clock-chips').innerHTML = chosen.map(c => `<span class="cchip"><i></i>${esc(c.name)} · ${esc(c.when)}</span>`).join('')
    + `<button class="cchip add" type="button" id="toggle-clocks">${state.panelOpen ? 'Done' : chosen.length ? 'Change' : '+ Pick clocks'}</button>`;
  const n = chosen.length;
  $('#estimate').innerHTML = n ? `${n} real Chrome run${n === 1 ? '' : 's'}<br>~${n * 20} Kane credits` : 'Pick a clock';
}
function renderClocks() {
  const max = state.setup.limits.maxCells;
  $('#clock-max').textContent = `up to ${max}`;
  $('#clocks').innerHTML = state.setup.presets.map((p) => {
    const on = state.selected.has(p.id);
    return `<button class="clock" type="button" aria-pressed="${on}" data-id="${esc(p.id)}" ${!on && state.selected.size >= max ? 'disabled' : ''}>
      <div class="city">${esc(p.name)} <span class="when">· ${esc(p.when)}</span></div>
      <div class="when">${esc(whenText(p))}</div>
      <div class="why">${esc(p.why)}</div></button>`;
  }).join('');
  renderChips();
}
$('#clock-chips').addEventListener('click', (e) => {
  if (e.target.id !== 'toggle-clocks') return;
  state.panelOpen = !state.panelOpen;
  $('#clock-panel').hidden = !state.panelOpen;
  renderChips();
});
$('#clocks').addEventListener('click', (e) => {
  const b = e.target.closest('.clock');
  if (!b || b.disabled) return;
  if (state.selected.has(b.dataset.id)) state.selected.delete(b.dataset.id);
  else state.selected.add(b.dataset.id);
  renderClocks();
});
for (const id of ['url', 'what']) {
  $(`#${id}`).addEventListener('input', e => e.target.classList.toggle('filled', !!e.target.value.trim()));
}
function renderSuggest() {
  $('#suggest').innerHTML = SUGGEST.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join('');
}
$('#suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const [what, rule] = SUGGEST[b.dataset.i];
  $('#what').value = what;
  $('#what').classList.add('filled');
  renderRules(rule);
  if (!$('#url').value.trim()) $('#url').focus();
});
$('#try-demo').addEventListener('click', () => state.setup && startRun({ demo: true, clocks: state.setup.presets.filter(p => DEFAULT_CLOCKS.includes(p.id)) }));

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.setup) return undefined;
  showError('#builder-error', '');
  let url = $('#url').value.trim();
  const what = $('#what').value.trim();
  if (!url && !(state.setup.config?.serve && !state.setup.publicMode)) { $('#url').focus(); return showError('#builder-error', 'Which page should Kane open?'); }
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!what) { $('#what').focus(); return showError('#builder-error', 'Which date should Kane check? For example: the delivery date at checkout.'); }
  if (!clocks().length) return showError('#builder-error', 'Pick at least one place and time.');
  const objective = `Go to {{app}}. Find ${what} on the page and store that date as 'date'.`;
  return startRun({ app: url || undefined, clocks: clocks(), flows: [{ id: 'date', name: what, objective, expect: { date: $('#rule').value } }] });
});

/* ---------- running ---------- */
async function startRun(body) {
  const res = await fetch('/api/run', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({ error: 'The server did not answer.' }));
  if (res.error) {
    toast(res.error);
    return showError('#builder-error', res.error);
  }
  state.runId = res.id;
  state.demo = !!body.demo;
  history.pushState(null, '', `/r/${res.id}`);
  prepareResults(body.demo ? 'Demo: a billing page with two date bugs' : (body.app || 'Your app'));
  const flows = body.demo ? [state.setup.demoFlow] : body.flows;
  listen(res.id, { kind: 'run', jobId: res.id, clocks: body.clocks, flows });
  return undefined;
}

function prepareResults(title) {
  $('#results').hidden = false;
  $('#results-title').textContent = 'Testing your page…';
  $('#results-sub').textContent = title;
  $('#grids').innerHTML = '';
  $('#policy').hidden = true;
  $('#fix-demo').hidden = true;
  $('#fix-own').hidden = true;
  $('#share').hidden = false;
  $('#report').hidden = true;
  $('#evidence').hidden = true;
  $('#status').textContent = '';
  showError('#fix-error', '');
  state.grids.clear();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function listen(jobId, ctx) {
  state.source?.close();
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.source = source;
  source.onmessage = (m) => {
    const event = JSON.parse(m.data);
    onEvent(event, ctx);
    if (event.type === 'end') source.close();
  };
  source.onerror = () => { if (source.readyState === 2) $('#status').textContent = 'Connection lost. Reload this page to see the result.'; };
}

function makeGrid(key, label, clocksList, flows, base) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `${label ? `<div class="grid-label">${esc(label)}</div>` : ''}<div class="summary" data-summary></div>
    ${flows.map(f => `${flows.length > 1 ? `<div class="flowname">${esc(f.name || f.id)}</div>` : ''}<div class="gridrow">${clocksList.map(c => `
      <button class="cell queued" type="button" data-cell="${esc(`${f.id}@${c.id}`)}" data-grid="${esc(key)}">
        <div class="thumb empty"></div>
        <div class="body"><div class="place">${esc(c.name || c.id)}${c.when ? ` · ${esc(c.when)}` : ''}</div><div class="time">${esc(whenText(c))}</div>
        <div class="v">QUEUED</div></div>
      </button>`).join('')}</div>`).join('')}`;
  $('#grids').appendChild(wrap);
  const grid = { key, el: wrap, base, cells: new Map(), summaryEl: wrap.querySelector('[data-summary]') };
  state.grids.set(key, grid);
  state.activeGrid = grid;
  return grid;
}

function cellEl(grid, id) { return grid.el.querySelector(`[data-cell="${CSS.escape(id)}"]`); }

function renderCell(grid, r) {
  const el = cellEl(grid, r.id);
  if (!el) return;
  el.className = `cell ${r.verdict}`;
  const thumb = r.kane.screenshot ? `<div class="thumb" style="background-image:url('${esc(`${grid.base}/${r.kane.screenshot}`)}')"></div>` : '<div class="thumb empty"></div>';
  const lines = r.checks.map(c => (c.status === 'pass'
    ? `<div class="line">${esc(c.key)} ✓ ${esc(c.shownRaw)}</div>`
    : `<div class="line bad">${esc(c.key)}: ${esc(c.shownRaw ?? '—')}<br>should be ${esc(c.expected)}</div>`)).join('');
  const disagree = r.kaneAgrees === false ? `<div class="disagree">Kane's own check said ${r.verdict === 'pass' ? 'FAIL' : 'PASS'}</div>` : '';
  el.innerHTML = `${thumb}<div class="body"><div class="place">${esc(r.clock.name || r.clock.id)}${r.clock.when ? ` · ${esc(r.clock.when)}` : ''}</div><div class="time">${esc(whenText(r.clock))}</div>
    <div class="v">${r.verdict.toUpperCase()}</div>${lines}${disagree}</div>`;
}

function updateSummary(grid) {
  const all = [...grid.el.querySelectorAll('.cell')];
  const count = cls => all.filter(c => c.classList.contains(cls)).length;
  grid.summaryEl.innerHTML = [[count('pass'), 'pass', 's-pass'], [count('fail'), 'fail', 's-fail'], [count('unknown'), 'unknown', 's-unk'], [count('running') + count('queued'), 'to go', 's-run']]
    .filter(([n]) => n > 0).map(([n, l, c]) => `<span class="${c}">${n} ${l}</span>`).join('');
}

function onEvent({ type, data }, ctx) {
  const statusEl = $('#status');
  if (type === 'queued') statusEl.textContent = data.position > 0 ? `In the queue: ${data.position} run${data.position === 1 ? '' : 's'} ahead of you. This page updates by itself.` : 'Starting…';
  if (type === 'grid-start') {
    statusEl.textContent = 'Opening your page in each time zone, in a real browser.';
    if (ctx.kind === 'run') makeGrid('run', '', ctx.clocks, ctx.flows, `/runs/${ctx.jobId}`);
    else makeGrid(`${ctx.jobId}:${data.name}`, `Every clock again, after fix ${String(data.name).split('-')[0]}`, ctx.clocks, ctx.flows, `/runs/${ctx.jobId}/${data.name}`);
  }
  const grid = state.activeGrid;
  if (type === 'cell-start' && grid) {
    const el = cellEl(grid, data.id);
    if (el) {
      el.className = 'cell running';
      el.querySelector('.v').innerHTML = '<span class="spinner"></span>CHECKING';
      el.querySelector('.body').insertAdjacentHTML('beforeend', '<div class="live">Opening Chrome at this place and time…</div>');
    }
    updateSummary(grid);
  }
  if (type === 'cell-step' && grid && data.status !== 'running' && !/^step \d+$/i.test(data.remark)) {
    const live = cellEl(grid, data.id)?.querySelector('.live');
    if (live) live.textContent = data.remark.replace(/^(\w+):\s*(PRIMARY:\s*)?/i, '');
  }
  if (type === 'cell-done' && grid) {
    grid.cells.set(data.id, data);
    renderCell(grid, data);
    updateSummary(grid);
  }
  if (type === 'grid-done' && grid) {
    const { pass, fail, unknown } = data.summary;
    if (ctx.kind === 'run') {
      $('#results-title').textContent = fail ? `Wrong date in ${fail} of ${pass + fail + unknown} time zones` : unknown ? 'No wrong dates found, but some time zones couldn’t be checked' : 'Every date is right in every time zone';
      $('#report').href = `/runs/${ctx.jobId}/report.html`;
      $('#report').hidden = false;
      $('#evidence').hidden = !data.evidence?.merged;
      $('#evidence').dataset.rel = `${ctx.jobId}/grid.evidence`;
      if (fail) {
        if (state.setup.liveFix && (state.demo || !state.setup.publicMode)) $('#fix-demo').hidden = false;
        else $('#fix-own').hidden = false;
      }
    }
    if (data.evidence?.merged) {
      const p = ctx.kind === 'run' ? $('#policy') : document.createElement('div');
      p.className = 'policy';
      p.hidden = false;
      p.innerHTML = `Kane policy ${esc(data.evidence.policy)} on the sealed grid evidence: <b class="${esc(data.evidence.policyVerdict)}">${esc(data.evidence.policyVerdict.toUpperCase())}</b>`;
      if (ctx.kind !== 'run') grid.el.appendChild(p);
    }
    statusEl.textContent = data.credits ? `${Math.round(data.credits)} Kane credits used.` : '';
  }
  if (type === 'agent-start') {
    const card = document.createElement('div');
    card.className = 'attempt';
    card.id = `attempt-${ctx.jobId}-${data.attempt}`;
    card.innerHTML = `<h3>Fix ${data.attempt} · Claude Code</h3><div class="agent-text"><span class="spinner"></span>Reading Kane's evidence for ${data.failing} red cell${data.failing === 1 ? '' : 's'} and editing the app…</div>`;
    $('#grids').appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (type === 'agent-done') renderAgent(ctx.jobId, data);
  if (type === 'end') {
    $('#fix').disabled = false;
    $('#fix').textContent = 'Fix with Claude';
    if (!data.ok) { statusEl.textContent = ''; showError('#fix-error', data.error); }
    if (ctx.kind === 'fix') {
      const done = document.createElement('div');
      done.className = 'attempt';
      done.innerHTML = data.status === 'green' ? '<div class="final green">✅ Every date is right now, in every time zone.</div>' : '<div class="final amber">Still red after the last attempt. Over to a human.</div>';
      $('#grids').appendChild(done);
      done.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    refreshCredits();
  }
}

function renderAgent(jobId, data) {
  let card = document.getElementById(`attempt-${jobId}-${data.attempt}`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'attempt';
    card.innerHTML = `<h3>Fix ${data.attempt} · Claude Code</h3><div class="agent-text"></div>`;
    $('#grids').appendChild(card);
  }
  card.querySelector('.agent-text').textContent = data.text || '(no message)';
  if (data.rejected) card.insertAdjacentHTML('beforeend', `<p class="error">Rejected: it changed ${esc((data.tampered || []).join(', '))}. Undone.</p>`);
  card.insertAdjacentHTML('beforeend', `<pre class="diff">${colorDiff(data.diff)}</pre>`);
}

function colorDiff(diff) {
  return esc(diff || '').split('\n').filter(l => !/^(diff --git|index |new file mode)/.test(l))
    .map(l => (/^\+(?!\+\+)/.test(l) ? `<span class="add">${l}</span>` : /^-(?!--)/.test(l) ? `<span class="del">${l}</span>` : /^@@/.test(l) ? `<span class="hunk">${l}</span>` : l)).join('\n');
}

const dedupe = list => [...new Map(list.map(c => [c.id, c])).values()];
const dedupeFlows = cells => [...new Map(cells.map(c => [c.flow, { id: c.flow, name: c.flowName }])).values()];

$('#fix').addEventListener('click', async () => {
  showError('#fix-error', '');
  const res = await fetch('/api/fix', { method: 'POST', body: JSON.stringify({ runId: state.runId }) }).then(r => r.json());
  if (res.error) return showError('#fix-error', res.error);
  $('#fix').disabled = true;
  $('#fix').innerHTML = '<span class="spinner"></span>Claude is fixing…';
  $('#fix-demo').hidden = true;
  history.pushState(null, '', `/r/${res.id}`);
  const first = [...state.grids.get('run').cells.values()];
  listen(res.id, { kind: 'fix', jobId: res.id, clocks: dedupe(first.map(c => c.clock)), flows: state.demo ? [state.setup.demoFlow] : dedupeFlows(first) });
  return undefined;
});

$('#copy-prompt').addEventListener('click', async () => {
  const text = await fetch(`/api/runs/${state.runId}/prompt`).then(r => r.text());
  await navigator.clipboard.writeText(text).then(() => toast('Fix prompt copied. Paste it into Claude Code in your repo.'), () => toast('Could not copy. Open the report instead.'));
});
$('#share').addEventListener('click', () => navigator.clipboard.writeText(location.href).then(() => toast('Share link copied.')));
$('#evidence').addEventListener('click', async (e) => {
  const res = await fetch('/api/evidence', { method: 'POST', body: JSON.stringify({ rel: e.currentTarget.dataset.rel }) }).then(r => r.json());
  if (res.url) window.open(res.url, '_blank', 'noopener');
  else toast(res.error || 'Could not open Kane’s evidence viewer.');
});

/* ---------- drawer ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('.cell');
  if (!el) return;
  const grid = state.grids.get(el.dataset.grid);
  const r = grid?.cells.get(el.dataset.cell);
  if (r) openDrawer(r, grid);
});
function openDrawer(r, grid) {
  $('#d-title').textContent = `${r.clock.name || r.clock.id}${r.clock.when ? ` · ${r.clock.when}` : ''}`;
  $('#d-sub').textContent = `${fmtTime(r.clock, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} · ${r.clock.tz}`;
  const shot = r.kane.screenshot ? `<img class="shot" src="${esc(`${grid.base}/${r.kane.screenshot}`)}" alt="The page as Kane saw it at this clock"><p class="note">The page as Kane saw it, in a Chrome that believed it was this place and time.</p>` : '';
  const rows = r.checks.map(c => `<tr><td class="mono">${esc(c.key)}</td><td class="${c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : ''}">${esc(c.shownRaw ?? '—')}</td><td>${esc(c.expected)}</td><td>${c.status === 'pass' ? '✓' : esc(c.reason || c.status)}</td></tr>`).join('');
  const steps = (r.kane.steps || []).map(s => `<li class="${s.status === 'failed' ? 'failed' : ''}">${esc(String(s.remark).replace(/^(\w+):\s*(PRIMARY:\s*)?/i, ''))}</li>`).join('');
  const kaneLine = r.kane.status ? `Kane's own check: <b>${r.kane.status === 'passed' ? 'PASS' : 'FAIL'}</b>${r.kaneAgrees === false ? ', which disagrees with the dates it read. tzproof goes by the dates.' : '.'}` : '';
  $('#d-body').innerHTML = `${shot}
    <table class="vals"><thead><tr><th>Date</th><th>Page showed</th><th>Should be</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">${kaneLine}${r.tries > 1 ? ` Retried ${r.tries - 1}× after a browser session error.` : ''}${r.kane.credits ? ` ${Number(r.kane.credits).toFixed(1)} Kane credits.` : ''}</p>
    <div class="dlinks"><a class="btn quiet small" href="${esc(`${grid.base}/${r.kane.ndjson}`)}" target="_blank">Kane's raw output</a>
    ${!state.setup.publicMode && r.kane.testUrl ? `<a class="btn quiet small" href="${esc(r.kane.testUrl)}" target="_blank" rel="noopener">Kane run in Test Manager ↗</a>` : ''}</div>
    ${r.kane.summary ? `<p class="note"><b>Kane's summary:</b> ${esc(r.kane.summary)}</p>` : ''}
    <details><summary>What Kane did (${(r.kane.steps || []).length} steps)</summary><ol class="steps">${steps}</ol></details>
    <details><summary>Instruction Kane got</summary><p class="note">${esc(r.objective)}</p></details>`;
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }
$('#d-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => e.key === 'Escape' && closeDrawer());

/* ---------- share links ---------- */
function showSavedGrid(key, label, results, base) {
  const g = makeGrid(key, label, results.clocks, results.flows, base);
  for (const c of results.cells) { g.cells.set(c.id, c); renderCell(g, c); }
  updateSummary(g);
  return g;
}

async function openSaved(id) {
  const saved = await fetch(`/api/runs/${id}`).then(r => r.json());
  if (saved.error) { toast(saved.error); return; }
  const { meta } = saved;
  const runId = meta.kind === 'fix' ? meta.from : id;
  state.runId = runId;
  state.demo = meta.demo;
  prepareResults(meta.demo ? 'Demo: a billing page with two date bugs' : (meta.app || 'Your app'));
  const flows = meta.demo ? [state.setup.demoFlow] : meta.flows;
  const first = meta.kind === 'fix' ? await fetch(`/api/runs/${runId}`).then(r => r.json()) : saved;
  if (meta.kind === 'run' && saved.live && saved.live !== 'done') {
    listen(id, { kind: 'run', jobId: id, clocks: meta.clocks, flows });
    return;
  }
  if (first.results) {
    showSavedGrid('run', '', first.results, `/runs/${runId}`);
    onEvent({ type: 'grid-done', data: { summary: first.results.summary, evidence: first.results.evidence } }, { kind: 'run', jobId: runId });
  }
  if (meta.kind === 'fix') {
    $('#fix-demo').hidden = true;
    if (saved.live && saved.live !== 'done') {
      listen(id, { kind: 'fix', jobId: id, clocks: meta.clocks, flows });
      return;
    }
    for (const a of (saved.loop?.attempts || []).filter(x => x.attempt > 0)) {
      renderAgent(id, { attempt: a.attempt, text: a.agent, diff: a.diffText, rejected: a.rejected, tampered: a.tampered || [] });
      const grid = saved.grids?.find(x => x.attempt === a.attempt);
      if (grid) showSavedGrid(`${id}:${grid.name}`, `Every clock again, after fix ${a.attempt}`, grid.results, `/runs/${id}/${grid.name}`);
    }
    if (saved.loop) onEvent({ type: 'end', data: { ok: true, status: saved.loop.status } }, { kind: 'fix', jobId: id });
  }
}

/* ---------- boot ---------- */
async function refreshCredits() {
  if (state.setup?.publicMode) {
    const s = await fetch('/api/setup').then(r => r.json()).catch(() => null);
    if (s?.today) $('#credits').textContent = `${s.today.creditsLeft.toLocaleString()} free Kane credits left today`;
    return;
  }
  const { balance } = await fetch('/api/balance').then(r => r.json()).catch(() => ({}));
  if (balance) $('#credits').textContent = `${Math.round(balance).toLocaleString()} Kane credits`;
}

async function boot() {
  state.setup = await fetch('/api/setup').then(r => r.json());
  const q = new URLSearchParams(location.search);
  renderRules(q.get('rule') || 'today+3d');
  if (q.get('what')) { $('#what').value = q.get('what'); $('#what').classList.add('filled'); }
  if (q.get('url')) { $('#url').value = q.get('url'); $('#url').classList.add('filled'); }
  if (!state.setup.publicMode && state.setup.config?.serve) $('#url').placeholder = `${state.setup.config.serve} (from tzproof.yaml)`;
  renderSuggest();
  renderClocks();
  refreshCredits();
  const shared = location.pathname.match(/^\/r\/([\w-]+)/);
  if (shared) openSaved(shared[1]);
  else if (q.get('what') && !q.get('url')) $('#url').focus();
}
window.addEventListener('popstate', () => location.reload());
boot();
