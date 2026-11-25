// Launch a Chrome that lives in another time zone and at another moment, for Kane CLI to attach to.
//
// The time zone comes from Chrome itself (TZ env at launch plus a CDP override on every page), so Intl,
// toLocaleString and getTimezoneOffset all agree. The clock is shifted by a small Date shim injected
// before any page script runs; it keeps ticking from the warped instant.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.TZPROOF_CHROME_PATH,
  process.env.KANE_CLI_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome() {
  const path = CHROME_CANDIDATES.find(p => p && existsSync(p));
  if (!path) {
    throw new Error('Google Chrome not found. Set TZPROOF_CHROME_PATH (or KANE_CLI_CHROME_PATH) to the Chrome binary.');
  }
  return path;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function clockShim(atMs) {
  return `(() => {
  const off = ${atMs} - Date.now(), R = Date;
  class D extends R {
    constructor(...a) { super(...(a.length ? a : [R.now() + off])); }
    static now() { return R.now() + off; }
  }
  window.Date = D;
})();`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {{ tz: string, at: string, headless?: boolean, width?: number, height?: number }} opts
 * @returns {Promise<{ endpoint: string, close: () => Promise<void> }>}
 */
export async function launchWarpedChrome({ tz, at, headless = true, width = 1920, height = 1080 }) {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) throw new Error(`Invalid instant "${at}" (use ISO 8601, e.g. 2026-04-10T09:00:00Z)`);

  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'tzproof-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new'] : []),
    // Containers usually run as root without user namespaces, where Chrome's sandbox can't start.
    ...(process.env.TZPROOF_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    'about:blank',
  ];
  const chrome = spawn(findChrome(), args, { env: { ...process.env, TZ: tz }, stdio: 'ignore' });

  let version;
  for (let i = 0; i < 150 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    }
    catch {
      await sleep(200);
    }
  }
  if (!version) {
    chrome.kill();
    throw new Error(`Chrome did not start on port ${port}`);
  }

  // A browser-level session auto-attaches to every page, including pages Kane opens later.
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
  const shim = clockShim(atMs);

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error);
      pending.delete(msg.id);
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;
    const sessionId = msg.params.sessionId;
    if (msg.params.targetInfo.type === 'page') {
      await send('Page.enable', {}, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: shim }, sessionId);
      await send('Emulation.setTimezoneOverride', { timezoneId: tz }, sessionId);
    }
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      try { ws.close(); } catch { /* already closed */ }
      // Wait for Chrome to really exit before deleting its profile; it keeps writing files while it shuts down.
      const exited = new Promise(r => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
      // Cleanup must never fail a run.
      for (let i = 0; i < 5; i++) {
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break; }
        catch { await sleep(400); }
      }
    },
  };
}
