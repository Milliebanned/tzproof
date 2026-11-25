const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const RULES = [
  ['today', 'today'], ['today+1d', 'tomorrow'], ['today-1d', 'yesterday'], ['today+3d', 'today + 3 days'],
  ['today+7d', 'today + 7 days'], ['today+14d', 'today + 14 days'], ['today+30d', 'today + 30 days'],
  ['today+1mo', 'today + 1 month'], ['today+1y', 'today + 1 year'],
];
const TEMPLATES = [
  { label: 'Today’s date on the page', objective: "Go to {{app}}. Store the date the page shows as today's date as 'today'.", expect: [['today', 'today']] },
  { label: 'Delivery estimate', objective: "Go to {{app}}. Store the estimated delivery date shown on the page as 'delivery'.", expect: [['delivery', 'today+3d']] },
  { label: 'Trial or renewal date', objective: "Go to {{app}}. Store the date the trial ends or the plan renews as 'renews'.", expect: [['renews', 'today+14d']] },
  { label: 'Due date', objective: "Go to {{app}}. Store the due date shown on the page as 'due'.", expect: [['due', 'today+30d']] },
];
const DEFAULT_CLOCKS = ['new-york-afternoon', 'tokyo-morning', 'los-angeles-evening', 'london-bst-midnight', 'month-end'];

const state = {
  setup: null, demo: false, url: '', selected: new Set(DEFAULT_CLOCKS), expects: [['today', 'today']],
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

/* ---------- hero: real clocks, right now ---------- */
function tickHero() {
  const now = new Date();
  const zones = [['Tokyo', 'Asia/Tokyo'], ['London', 'Europe/London'], ['New York', 'America/New_York'], ['Los Angeles', 'America/Los_Angeles'], ['UTC', 'UTC']];
  const utcDay = now.toISOString().slice(0, 10);
  $('#clockline').innerHTML = zones.map(([city, tz]) => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(now);
    return `<span class="tick ${day !== utcDay ? 'bad' : ''}" title="${day !== utcDay ? 'A different calendar day than UTC right now' : ''}"><b>${city}</b>${t}</span>`;
  }).join('');
}

/* ---------- builder ---------- */
function renderTemplates() {
  $('#templates').innerHTML = TEMPLATES.map((t, i) => `<button class="tpl" type="button" data-i="${i}">${esc(t.label)}</button>`).join('');
}
$('#templates').addEventListener('click', (e) => {
  const b = e.target.closest('.tpl');
  if (!b) return;
  const t = TEMPLATES[b.dataset.i];
  $('#objective').value = t.objective;
  state.expects = t.expect.map(x => [...x]);
  renderExpects();
});

function renderExpects() {
  $('#expects').innerHTML = state.expects.map(([key, rule], i) => `
    <div class="expect" data-i="${i}">
      <input class="x-key" value="${esc(key)}" placeholder="stored as" aria-label="Name Kane stores the date under">
      <select class="x-rule" aria-label="What the date should be">${RULES.map(([v, l]) => `<option value="${v}" ${v === rule ? 'selected' : ''}>should be ${l}</option>`).join('')}</select>
      <button class="btn quiet small x-del" type="button" aria-label="Remove">✕</button>
    </div>`).join('');
}
$('#expects').addEventListener('input', (e) => {
  const i = e.target.closest('.expect')?.dataset.i;
  if (i === undefined) return;
  if (e.target.classList.contains('x-key')) state.expects[i][0] = e.target.value.trim().replace(/\W+/g, '_');
  if (e.target.classList.contains('x-rule')) state.expects[i][1] = e.target.value;
});
$('#expects').addEventListener('click', (e) => {
  if (!e.target.classList.contains('x-del')) return;
  state.expects.splice(e.target.closest('.expect').dataset.i, 1);
  renderExpects();
});
$('#add-expect').addEventListener('click', () => { state.expects.push(['', 'today']); renderExpects(); });

function renderClocks() {
  const max = state.setup.limits.maxCells;
  $('#clocks').innerHTML = state.setup.presets.map((p) => {
    const on = state.selected.has(p.id);
    return `<button class="clock" type="button" aria-pressed="${on}" data-id="${esc(p.id)}" ${!on && state.selected.size >= max ? 'disabled' : ''}>
      <div class="city">${esc(p.name)} <span class="when">${esc(p.when)}</span></div>
      <div class="when">${esc(whenText(p))}</div>
      <div class="why">${esc(p.why)}</div></button>`;
  }).join('');
  const n = state.selected.size;
  $('#estimate').textContent = n ? `${n} Kane run${n === 1 ? '' : 's'} in a real Chrome · about ${n * 20} Kane credits · ~${Math.ceil(n / 2) + 1} min` : 'Pick at least one place and time.';
}
$('#clocks').addEventListener('click', (e) => {
  const b = e.target.closest('.clock');
  if (!b || b.disabled) return;
  if (state.selected.has(b.dataset.id)) state.selected.delete(b.dataset.id);
  else state.selected.add(b.dataset.id);
  renderClocks();
});

function openBuilder(url) {
  state.demo = false;
  state.url = url;
  $('#results').hidden = true;
  $('#builder').hidden = false;
  $('#builder-title').textContent = 'Test your site';
  $('#builder-url').textContent = url || (state.setup.config?.serve ? `Serving ${state.setup.config.serve} from your tzproof.yaml` : '');
  if (!$('#objective').value) $('#objective').value = TEMPLATES[0].objective;
  renderExpects();
  renderClocks();
  $('#builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.setup) return;
  let url = $('#url').value.trim();
  if (!url && state.setup.publicMode) { $('#url').focus(); return; }
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  openBuilder(url);
});
$('#change-url').addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); $('#url').focus(); });
$('#try-demo').addEventListener('click', () => state.setup && startRun({ demo: true, clocks: state.setup.presets.filter(p => DEFAULT_CLOCKS.includes(p.id)) }));

$('#run').addEventListener('click', () => {
  showError('#builder-error', '');
  const expect = Object.fromEntries(state.expects.filter(([k]) => k).map(([k, r]) => [k, r]));
  const objective = $('#objective').value.trim();
  if (!objective) return showError('#builder-error', 'Tell Kane what to look at.');
  if (!Object.keys(expect).length) return showError('#builder-error', 'Add at least one date to check.');
  const missing = Object.keys(expect).filter(k => !objective.includes(k));
  if (missing.length) return showError('#builder-error', `Your instruction should tell Kane to store ${missing.map(k => `'${k}'`).join(' and ')}.`);
  if (!clocks().length) return showError('#builder-error', 'Pick at least one place and time.');
  return startRun({ app: state.url || undefined, clocks: clocks(), dateOrder: $('#date-order').value, flows: [{ id: 'dates', name: 'Dates', objective, expect }] });
});

/* ---------- running ---------- */
async function startRun(body) {
  const res = await fetch('/api/run', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({ error: 'The server did not answer.' }));
  if (res.error) {
    if (body.demo) toast(res.error);
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
  $('#builder').hidden = true;
  $('#results').hidden = false;
  $('#results-title').textContent = 'Kane is testing';
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
    statusEl.textContent = 'Kane is opening a real Chrome at each place and time.';
    if (ctx.kind === 'run') makeGrid('run', '', ctx.clocks, ctx.flows, `/runs/${ctx.jobId}`);
    else makeGrid(`${ctx.jobId}:${data.name}`, `Every clock again, after fix ${String(data.name).split('-')[0]}`, ctx.clocks, ctx.flows, `/runs/${ctx.jobId}/${data.name}`);
  }
  const grid = state.activeGrid;
  if (type === 'cell-start' && grid) {
    const el = cellEl(grid, data.id);
    if (el) {
      el.className = 'cell running';
      el.querySelector('.v').innerHTML = '<span class="spinner"></span>KANE IS ON IT';
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
      $('#results-title').textContent = fail ? `${fail} of ${pass + fail + unknown} clocks show a wrong date` : unknown ? 'No wrong dates, but some clocks are unproven' : 'Every date is right, at every clock';
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
      done.innerHTML = data.status === 'green' ? '<div class="final green">✅ Every clock is green.</div>' : '<div class="final amber">Still red after the last attempt. Over to a human.</div>';
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
  tickHero();
  setInterval(tickHero, 15000);
  state.setup = await fetch('/api/setup').then(r => r.json());
  renderTemplates();
  refreshCredits();
  if (!state.setup.publicMode && state.setup.config) {
    const cfg = state.setup.config;
    const f = cfg.flows[0];
    $('#objective').value = f.objective.trim();
    state.expects = Object.entries(f.expect || {}).map(([k, v]) => [k, typeof v === 'string' ? v : v.date]);
    const ids = new Set(state.setup.presets.map(p => p.id));
    state.selected = new Set(cfg.clocks.map(c => c.id).filter(x => ids.has(x)));
    if (cfg.app) $('#url').value = cfg.app;
  }
  const shared = location.pathname.match(/^\/r\/([\w-]+)/);
  if (shared) openSaved(shared[1]);
}
window.addEventListener('popstate', () => location.reload());
boot();
