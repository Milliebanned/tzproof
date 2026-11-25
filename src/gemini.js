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

let cachedModel = null;
async function pickModel(key) {
  if (process.env.TZPROOF_GEMINI_MODEL) return process.env.TZPROOF_GEMINI_MODEL;
  if (cachedModel) return cachedModel;
  const res = await fetch(`${API}/models?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!res.ok) throw new Error(`Gemini: could not list models (${res.status})`);
  const { models = [] } = await res.json();
  const usable = models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  // Prefer a current "flash" model: fast and on the free tier.
  const flash = usable.filter(n => /flash/.test(n) && !/lite|image|tts|audio|live|thinking-exp/.test(n));
  cachedModel = flash.sort().reverse()[0] || usable[0];
  if (!cachedModel) throw new Error('Gemini: no model available for this key');
  return cachedModel;
}

/**
 * @returns {Promise<{ code: number, text: string, cost: null, stderr: string, written: string[] }>}
 */
export async function runGeminiFixer(prompt, editDir) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { code: 1, text: 'GEMINI_API_KEY is not set.', cost: null, stderr: '', written: [] };
  try {
    const files = sourceFiles(editDir);
    const model = await pickModel(key);
    const request = `${prompt}

You cannot run tools. Instead, here is every source file in the folder you may edit:

${files.map(f => `=== FILE: ${f.path} ===\n${f.content}`).join('\n\n')}

Answer with JSON only, in this shape:
{"root_cause": "one or two sentences", "fix": "one or two sentences", "files": [{"path": "relative/path", "content": "the complete new file"}]}
Only include files you changed, with their complete new content.`;
    const res = await fetch(`${API}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: request }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message || 'request failed'}`);
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
