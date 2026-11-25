// A fixer that calls the Gemini API directly. Gemini gets the failing cells, Kane's evidence and the app's source,
// and answers with whole replacement files. tzproof writes them, and only inside the folder it may edit: Gemini has
// no tools and no shell.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.json', '.py', '.rb', '.go', '.php']);
const MAX_BYTES = 200_000;

function sourceFiles(dir) {
  const out = [];
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!TEXT.has(extname(name))) continue;
      const text = readFileSync(full, 'utf8');
      total += text.length;
      if (total > MAX_BYTES) throw new Error(`The app folder is too big to send to Gemini (over ${MAX_BYTES / 1000} kB of source).`);
      out.push({ path: relative(dir, full), content: text });
    }
  };
  walk(dir);
  return out;
}

// Free-tier friendly models first. Names change over time, so on "busy", "no quota" or "not available" the next
// one is tried.
const PREFERRED = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];

async function generate(key, model, request) {
  // A dropped connection or a slow answer counts as "busy": the caller retries and then tries the next model.
  try {
    const res = await fetch(`${API}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: request }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }
  catch (err) {
    return { status: 503, ok: false, body: { error: { message: `network: ${err.cause?.code || err.name || err.message}` } } };
  }
}

/**
 * @returns {Promise<{ code: number, text: string, cost: null, stderr: string, written: string[] }>}
 */
export async function runGeminiFixer(prompt, editDir) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { code: 1, text: 'GEMINI_API_KEY is not set.', cost: null, stderr: '', written: [] };
  try {
    const files = sourceFiles(editDir);
    const request = `${prompt}

You cannot run tools. Instead, here is every source file in the folder you may edit:

${files.map(f => `=== FILE: ${f.path} ===\n${f.content}`).join('\n\n')}

Answer with JSON only, in this shape:
{"root_cause": "one or two sentences", "fix": "one or two sentences", "files": [{"path": "relative/path", "content": "the complete new file"}]}
Only include files you changed, with their complete new content.`;
    const models = [...new Set([process.env.TZPROOF_GEMINI_MODEL, ...PREFERRED].filter(Boolean))];
    let model;
    let body;
    let lastError = 'no model answered';
    outer: for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await generate(key, m, request);
        if (r.ok) { model = m; body = r.body; break outer; }
        lastError = `${m}: ${r.status} ${r.body.error?.message?.slice(0, 120) || ''}`;
        if (r.status === 404) break;
        if (![429, 500, 503].includes(r.status)) break outer;
        await new Promise(res => setTimeout(res, 4000));
      }
    }
    if (!body) throw new Error(`Gemini could not be reached (${lastError})`);
    const raw = body.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const answer = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const written = [];
    for (const f of answer.files || []) {
      const target = normalize(join(editDir, String(f.path)));
      // Never write outside the app folder, whatever the model says.
      if (!target.startsWith(`${normalize(editDir)}/`) && target !== normalize(editDir)) continue;
      if (!existsSync(target) && !TEXT.has(extname(target))) continue;
      writeFileSync(target, String(f.content));
      written.push(relative(editDir, target));
    }
    const text = `Root cause: ${answer.root_cause || '(not given)'}\nFix: ${answer.fix || '(not given)'}\n(Gemini ${model}; changed ${written.join(', ') || 'nothing'})`;
    return { code: 0, text, cost: null, stderr: '', written };
  }
  catch (err) {
    return { code: 1, text: `Gemini could not produce a fix: ${err.message}`, cost: null, stderr: err.message, written: [] };
  }
}
