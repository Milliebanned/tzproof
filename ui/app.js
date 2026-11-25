const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const RULES = [
  ['today', 'today'], ['today+1d', 'tomorrow'], ['today-1d', 'yesterday'], ['today+7d', 'today + 7 days'],
  ['today+14d', 'today + 14 days'], ['today+30d', 'today + 30 days'], ['today+1mo', 'today + 1 month'], ['today+1y', 'today + 1 year'],
];

const state = {
  presets: [],
  selected: new Set(),
  custom: [],
  flows: [],
  serve: null,
  runId: null,
  grids: new Map(),      // name -> { el, base, cells: Map(id -> result), clocks, flows }
  activeGrid: null,
};

function localTime(clock) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: clock.tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(clock.at));
}

function allClocks() {
  return [...state.presets.filter(p => state.selected.has(p.id)), ...state.custom];
}

/* ---------- setup ---------- */

function renderPresets() {
  $('#presets').innerHTML = state.presets.map(p => `
    <label class="preset ${state.selected.has(p.id) ? 'on' : ''}" data-id="${esc(p.id)}">
      <input type="checkbox" ${state.selected.has(p.id) ? 'checked' : ''}>
      <span><b>${esc(p.name)}</b><small>${esc(localTime(p))} · ${esc(p.why || p.tz)}</small></span>
    </label>`).join('') + state.custom.map((c, i) => `
    <label class="preset on" data-custom="${i}">
      <input type="checkbox" checked>
      <span><b>${esc(c.name)}</b><small>${esc(localTime(c))}</small></span>
    </label>`).join('');
  updateEstimate();
}

$('#presets').addEventListener('change', (e) => {
  const label = e.target.closest('.preset');
  if (label.dataset.custom !== undefined) state.custom.splice(Number(label.dataset.custom), 1);
  else if (e.target.checked) state.selected.add(label.dataset.id);
  else state.selected.delete(label.dataset.id);
  renderPresets();
});

$('#add-custom').addEventListener('click', () => {
  const tz = $('#custom-tz').value.trim();
  const local = $('#custom-at').value;
  if (!tz || !local) return;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
  catch { return showError('#setup-error', `"${tz}" is not a time zone name, like Europe/Paris.`); }
  // The picker gives a wall-clock time in that zone: find the UTC instant that shows it there.
  const guess = Date.parse(`${local}:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
  const get = t => parts.find(p => p.type === t).value;
  const shown = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`);
  const at = new Date(guess - (shown - guess)).toISOString().replace('.000', '');
  const id = `custom-${tz.replace(/\W+/g, '-').toLowerCase()}-${state.custom.length + 1}`;
  state.custom.push({ id, name: `${tz.split('/').pop().replace(/_/g, ' ')}, custom`, tz, at });
  renderPresets();
});

function renderFlows() {
  $('#flows').innerHTML = state.flows.map((f, i) => `
    <div class="flow" data-i="${i}">
      <div class="flow-head">
        <input class="f-name" value="${esc(f.name)}" placeholder="Name, e.g. Billing dates">
        ${state.flows.length > 1 ? '<button class="ghost mini f-del" type="button">Remove</button>' : ''}
      </div>
      <label>What Kane should do (plain English; <code>{{app}}</code> is your URL)
        <textarea class="f-obj">${esc(f.objective)}</textarea>
      </label>
      <div class="muted" style="font-size:12px">Each date it stores, and what it should be for the user:</div>
      ${f.expect.map((x, j) => `
        <div class="expect" data-j="${j}">
          <input class="x-key" value="${esc(x.key)}" placeholder="stored as…">
          <select class="x-rule">${RULES.map(([v, l]) => `<option value="${v}" ${v === x.rule ? 'selected' : ''}>${l}</option>`).join('')}
            ${RULES.some(([v]) => v === x.rule) ? '' : `<option value="${esc(x.rule)}" selected>${esc(x.rule)}</option>`}</select>
          <button class="ghost mini x-del" type="button" aria-label="Remove">✕</button>
        </div>`).join('')}
      <button class="ghost mini x-add" type="button" style="margin-top:6px">+ Add a date</button>
    </div>`).join('');
  updateEstimate();
}

$('#flows').addEventListener('input', (e) => {
  const fi = e.target.closest('.flow')?.dataset.i;
  if (fi === undefined) return;
  const flow = state.flows[fi];
  if (e.target.classList.contains('f-name')) flow.name = e.target.value;
  if (e.target.classList.contains('f-obj')) flow.objective = e.target.value;
  const xj = e.target.closest('.expect')?.dataset.j;
  if (xj !== undefined) {
    if (e.target.classList.contains('x-key')) flow.expect[xj].key = e.target.value.trim();
    if (e.target.classList.contains('x-rule')) flow.expect[xj].rule = e.target.value;
  }
});
$('#flows').addEventListener('click', (e) => {
  const fi = e.target.closest('.flow')?.dataset.i;
  if (fi === undefined) return;
  if (e.target.classList.contains('f-del')) state.flows.splice(fi, 1);
  else if (e.target.classList.contains('x-add')) state.flows[fi].expect.push({ key: '', rule: 'today' });
  else if (e.target.classList.contains('x-del')) state.flows[fi].expect.splice(e.target.closest('.expect').dataset.j, 1);
  else return;
  renderFlows();
});
$('#add-flow').addEventListener('click', () => {
  state.flows.push({ id: `check-${state.flows.length + 1}`, name: `Check ${state.flows.length + 1}`, objective: 'Go to {{app}}. Store the text shown next to … as …', expect: [{ key: '', rule: 'today' }] });
  renderFlows();
});

function updateEstimate() {
  const n = allClocks().length * state.flows.length;
  $('#estimate').textContent = n ? `${n} Kane run${n === 1 ? '' : 's'} · about ${n * 20} credits` : '';
}

function showError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = !msg;
}

/* ---------- grid ---------- */

function makeGrid(name, label, clocks, flows, container, base) {
  const wrap = container === $('#grid') ? null : document.createElement('div');
  let table = $('#grid');
  if (wrap) {
    wrap.innerHTML = `<div class="grid-label">${esc(label)} <span class="summary" data-summary></span></div><div class="grid-wrap"><table class="grid"></table></div>`;
    container.appendChild(wrap);
    table = wrap.querySelector('table');
  }
  table.innerHTML = `<thead><tr><th></th>${clocks.map(c => `<th>${esc(c.name || c.id)}<small>${esc(localTime(c))}</small><small>${esc(c.tz)}</small></th>`).join('')}</tr></thead>
    <tbody>${flows.map(f => `<tr><th class="flow-name">${esc(f.name || f.id)}</th>${clocks.map(c => `
      <td class="cell queued" data-cell="${esc(`${f.id}@${c.id}`)}" data-grid="${esc(name)}"><div class="v">QUEUED</div></td>`).join('')}</tr>`).join('')}</tbody>`;
  const grid = { name, el: table, base, cells: new Map(), summaryEl: wrap ? wrap.querySelector('[data-summary]') : $('#summary') };
  state.grids.set(name, grid);
  state.activeGrid = grid;
  updateSummary(grid);
  return grid;
}

function cellEl(grid, id) {
  return grid.el.querySelector(`[data-cell="${CSS.escape(id)}"]`);
}

function renderCell(grid, id) {
  const td = cellEl(grid, id);
  const r = grid.cells.get(id);
  if (!td || !r) return;
  td.className = `cell ${r.verdict}`;
  const lines = r.checks.map(c => c.status === 'pass'
    ? `<div class="line">${esc(c.key)} ✓</div>`
    : `<div class="line">${esc(c.key)}: ${esc(c.reason)}</div>`).join('');
  const disagree = r.kaneAgrees === false ? `<div class="disagree">Kane's own check said ${r.verdict === 'pass' ? 'FAIL' : 'PASS'}</div>` : '';
  td.innerHTML = `<div class="v">${r.verdict.toUpperCase()}</div>${lines}${disagree}`;
}

function updateSummary(grid) {
  const all = [...grid.el.querySelectorAll('.cell')];
  const count = cls => all.filter(td => td.classList.contains(cls)).length;
  const parts = [
    [count('pass'), 'pass', 's-pass'], [count('fail'), 'fail', 's-fail'], [count('unknown'), 'unknown', 's-unk'],
    [count('running') + count('queued'), 'to go', 's-run'],
  ].filter(([n]) => n > 0).map(([n, l, c]) => `<span class="${c}">${n} ${l}</span>`);
  grid.summaryEl.innerHTML = parts.join('');
}

function onEvent(event, ctx) {
  const { type, data } = event;
  if (type === 'grid-start') {
    if (ctx.kind === 'run') {
      state.grids.clear();
      makeGrid('run', 'Grid', ctx.clocks, ctx.flows, $('#grid'), `/runs/${ctx.jobId}`);
    }
    else {
      makeGrid(`${ctx.jobId}:${data.name}`, `Every clock again, after fix ${data.name.split('-')[0]}`, ctx.clocks, ctx.flows, $('#timeline'), `/runs/${ctx.jobId}/${data.name}`);
    }
  }
  const grid = state.activeGrid;
  if (type === 'cell-start' && grid) {
    const td = cellEl(grid, data.id);
    if (td) { td.className = 'cell running'; td.innerHTML = '<div class="v"><span class="spinner"></span>KANE IS ON IT</div><div class="live">Opening Chrome at this clock…</div>'; }
    updateSummary(grid);
  }
  if (type === 'cell-step' && grid && data.status !== 'running' && !/^step \d+$/i.test(data.remark)) {
    const live = cellEl(grid, data.id)?.querySelector('.live');
    if (live) live.textContent = data.remark.replace(/^(\w+):\s*(PRIMARY:\s*)?/i, '');
  }
  if (type === 'cell-done' && grid) {
    grid.cells.set(data.id, data);
    renderCell(grid, data.id);
    updateSummary(grid);
  }
  if (type === 'grid-done' && grid) {
    if (ctx.kind === 'run') showRunDone(data, ctx);
    if (data.evidence?.merged) {
      const policy = ctx.kind === 'run' ? $('#policy') : document.createElement('div');
      policy.className = 'policy';
      policy.hidden = false;
      policy.innerHTML = `Kane policy <code>${esc(data.evidence.policy)}</code> on the sealed grid evidence: <b class="${esc(data.evidence.policyVerdict)}">${esc(data.evidence.policyVerdict.toUpperCase())}</b>`;
      if (ctx.kind !== 'run') grid.el.closest('div').parentElement.appendChild(policy);
    }
  }
  if (type === 'agent-start') {
    const card = document.createElement('div');
    card.className = 'attempt';
    card.id = `attempt-${ctx.jobId}-${data.attempt}`;
    card.innerHTML = `<h3>Fix ${data.attempt}: Claude Code</h3><div class="agent-text"><span class="spinner"></span>Reading Kane's evidence for ${data.failing} failing cell${data.failing === 1 ? '' : 's'} and editing your app…</div>`;
    $('#timeline').appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (type === 'agent-done') {
    const card = document.getElementById(`attempt-${ctx.jobId}-${data.attempt}`);
    if (card) {
      card.querySelector('.agent-text').textContent = data.text || '(no message)';
      if (data.rejected) card.insertAdjacentHTML('beforeend', `<p class="error">Rejected: it changed ${esc(data.tampered.join(', '))}. Undone.</p>`);
      card.insertAdjacentHTML('beforeend', `<pre class="diff">${colorDiff(data.diff)}</pre>`);
    }
  }
  if (type === 'end') {
    $('#run').disabled = false;
    $('#run').textContent = 'Run with Kane';
    $('#fix').disabled = false;
    $('#fix').textContent = 'Fix with Claude';
    if (!data.ok) showError(ctx.kind === 'run' ? '#setup-error' : '#fix-error', data.error);
    if (ctx.kind === 'fix') {
      const done = document.createElement('div');
      done.className = 'attempt final';
      done.innerHTML = data.status === 'green'
        ? '<h3 style="color:var(--pass-fg)">✅ Every clock is green.</h3>'
        : '<h3 style="color:var(--unk-fg)">Still failing after the last attempt. Over to you.</h3>';
      $('#timeline').appendChild(done);
      done.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    refreshBalance();
  }
}

function colorDiff(diff) {
  return esc(diff || '').split('\n')
    .filter(l => !/^(diff --git|index |new file mode)/.test(l))
    .map(l => (/^\+(?!\+\+)/.test(l) ? `<span class="add">${l}</span>` : /^-(?!--)/.test(l) ? `<span class="del">${l}</span>` : /^@@/.test(l) ? `<span class="hunk">${l}</span>` : l))
    .join('\n');
}

function showRunDone(data, ctx) {
  $('#board-title').textContent = 'Grid';
  const link = $('#report-link');
  link.href = `/runs/${ctx.jobId}/report.html`;
  link.hidden = false;
  $('#open-pack').hidden = !data.evidence?.merged;
  $('#open-pack').dataset.rel = `${ctx.jobId}/grid.evidence`;
  $('#fix-box').hidden = !(data.summary.fail > 0);
}

function listen(jobId, ctx) {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  source.onmessage = (m) => {
    const event = JSON.parse(m.data);
    onEvent(event, ctx);
    if (event.type === 'end') source.close();
  };
}

/* ---------- actions ---------- */

function collect() {
  const flows = state.flows.map((f, i) => ({
    id: f.id || `check-${i + 1}`,
    name: f.name || `Check ${i + 1}`,
    objective: f.objective,
    expect: Object.fromEntries(f.expect.filter(x => x.key).map(x => [x.key, x.rule])),
  }));
  return { app: $('#app').value.trim() || undefined, serve: state.serve || undefined, clocks: allClocks(), flows };
}

$('#run').addEventListener('click', async () => {
  showError('#setup-error', '');
  const body = { ...collect(), parallel: $('#parallel').value, fixEdit: $('#fix-edit').value.trim() || undefined };
  if (!body.app && !body.serve) return showError('#setup-error', 'Enter your app’s URL.');
  if (!body.clocks.length) return showError('#setup-error', 'Pick at least one place and time.');
  if (body.flows.some(f => !Object.keys(f.expect).length)) return showError('#setup-error', 'Each check needs at least one date to compare.');
  const res = await fetch('/api/run', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  if (res.error) return showError('#setup-error', res.error);
  state.runId = res.id;
  $('#empty').hidden = true;
  $('#board').hidden = false;
  $('#timeline').innerHTML = '';
  $('#policy').hidden = true;
  $('#fix-box').hidden = true;
  $('#run').disabled = true;
  $('#run').innerHTML = '<span class="spinner"></span>Kane is running…';
  listen(res.id, { kind: 'run', jobId: res.id, clocks: body.clocks, flows: body.flows });
});

$('#fix').addEventListener('click', async () => {
  showError('#fix-error', '');
  const fixEdit = $('#fix-edit').value.trim();
  if (!fixEdit) return showError('#fix-error', 'Choose the folder Claude may edit.');
  const res = await fetch('/api/fix', { method: 'POST', body: JSON.stringify({ runId: state.runId, fixEdit, parallel: $('#parallel').value }) }).then(r => r.json());
  if (res.error) return showError('#fix-error', res.error);
  $('#fix').disabled = true;
  $('#fix').innerHTML = '<span class="spinner"></span>Claude is fixing…';
  const { clocks, flows } = collect();
  listen(res.id, { kind: 'fix', jobId: res.id, clocks, flows });
});

async function openEvidence(body, button) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening Kane’s viewer…';
  const res = await fetch('/api/evidence', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  button.disabled = false;
  button.textContent = old;
  if (res.url) window.open(res.url, '_blank', 'noopener');
  else alertInline(button, res.error || 'Could not open the evidence.');
}

function alertInline(el, msg) {
  el.insertAdjacentHTML('afterend', `<p class="error">${esc(msg)}</p>`);
}

$('#open-pack').addEventListener('click', e => openEvidence({ rel: e.target.dataset.rel }, e.target));

/* ---------- drawer ---------- */

document.addEventListener('click', (e) => {
  const td = e.target.closest('.cell');
  if (!td) return;
  const grid = state.grids.get(td.dataset.grid);
  const r = grid?.cells.get(td.dataset.cell);
  if (!r) return;
  openDrawer(r, grid);
});

function openDrawer(r, grid) {
  $('#d-title').textContent = `${r.flowName} · ${r.clock.name || r.clock.id}`;
  $('#d-sub').textContent = `${localTime(r.clock)} · ${r.clock.tz}`;
  const shot = r.kane.screenshot ? `<img class="shot" src="${esc(`${grid.base}/${r.kane.screenshot}`)}" alt="The page as Kane saw it at this clock">
    <div class="note">The page as Kane saw it, in a Chrome that believed it was ${esc(localTime(r.clock))}.</div>` : '';
  const rows = r.checks.map(c => `<tr><td>${esc(c.key)}</td><td class="${c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : ''}">${esc(c.shownRaw ?? '—')}</td><td>${esc(c.expected)}</td><td>${c.status === 'pass' ? '✓' : esc(c.reason || c.status)}</td></tr>`).join('');
  const kaneVerdict = r.kane.status ? `Kane's own check: <b>${esc(r.kane.status === 'passed' ? 'PASS' : 'FAIL')}</b>${r.kaneAgrees === false ? ' — it disagrees with the date check. tzproof goes by the dates Kane read.' : ''}` : '';
  const steps = (r.kane.steps || []).filter(s => s.status !== 'running').map(s => `<li class="${s.status === 'failed' ? 'failed' : ''}">${esc(String(s.remark).replace(/^(\w+):\s*(PRIMARY:\s*)?/i, ''))}</li>`).join('');
  $('#d-body').innerHTML = `
    ${shot}
    <table class="vals"><thead><tr><th>Date</th><th>Page showed</th><th>Should be</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">${kaneVerdict}${r.tries > 1 ? ` · retried ${r.tries - 1}× after a browser session error` : ''}${r.kane.credits ? ` · ${Number(r.kane.credits).toFixed(1)} credits` : ''}</p>
    <div class="links">
      ${r.kane.evidence ? '<button class="ghost" id="d-evidence" type="button">Open in Kane’s evidence viewer</button>' : ''}
      ${r.kane.testUrl ? `<a class="ghost-link" href="${esc(r.kane.testUrl)}" target="_blank" rel="noopener">Kane run in Test Manager ↗</a>` : ''}
      <a class="ghost-link" href="${esc(`${grid.base}/${r.kane.ndjson}`)}" target="_blank">Kane NDJSON</a>
    </div>
    ${r.kane.summary ? `<p class="note"><b>Kane's summary:</b> ${esc(r.kane.summary)}</p>` : ''}
    <details><summary class="muted">What Kane did (${(r.kane.steps || []).length} steps)</summary><ol class="steps">${steps}</ol></details>
    <details><summary class="muted">Instruction Kane received</summary><p class="note">${esc(r.objective)}</p></details>`;
  const ev = $('#d-evidence');
  if (ev) ev.addEventListener('click', () => openEvidence({ pack: r.kane.evidence }, ev));
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
}

function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }
$('#d-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => e.key === 'Escape' && closeDrawer());

/* ---------- boot ---------- */

async function refreshBalance() {
  const { balance } = await fetch('/api/balance').then(r => r.json()).catch(() => ({}));
  $('#balance').textContent = balance ? `Kane credits ${Math.round(balance).toLocaleString()}` : 'Kane credits —';
}

async function boot() {
  const setup = await fetch('/api/setup').then(r => r.json());
  state.presets = setup.presets;
  const cfg = setup.config;
  if (cfg) {
    if (cfg.serve) {
      state.serve = cfg.serve;
      $('#app').value = '';
      $('#app').placeholder = `Studio serves ${cfg.serve} for you`;
      $('#serve-hint').textContent = `Using the folder ${cfg.serve} from your tzproof.yaml. Enter a URL to test a running app instead.`;
      $('#serve-hint').hidden = false;
    }
    else $('#app').value = cfg.app || '';
    const presetIds = new Set(state.presets.map(p => p.id));
    for (const c of cfg.clocks) {
      if (presetIds.has(c.id)) state.selected.add(c.id);
      else state.custom.push(c);
    }
    state.flows = cfg.flows.map(f => ({ id: f.id, name: f.name || f.id, objective: f.objective.trim(), expect: Object.entries(f.expect || {}).map(([key, rule]) => ({ key, rule: typeof rule === 'string' ? rule : rule.date })) }));
    if (cfg.fixEdit) $('#fix-edit').value = cfg.fixEdit;
  }
  else {
    ['new-york-afternoon', 'tokyo-morning', 'los-angeles-evening', 'london-bst-midnight', 'month-end'].forEach(id => state.selected.add(id));
    state.flows = [{ id: 'dates', name: 'Account dates', objective: "Go to {{app}}. Store the text shown next to 'Trial ends' as 'trial_end'.", expect: [{ key: 'trial_end', rule: 'today+14d' }] }];
  }
  $('#tz-list').innerHTML = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map(z => `<option value="${z}">`).join('');
  renderPresets();
  renderFlows();
  $('#balance').textContent = setup.balance ? `Kane credits ${Math.round(setup.balance).toLocaleString()}` : 'Kane credits —';
}

boot();
