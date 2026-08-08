#!/usr/bin/env node
// Startup frame capture harness for issue #2762 reproduction.
//
// Connects to the Electron renderer over the Chrome DevTools Protocol
// (--remote-debugging-port) and captures the composited page view as fast as
// possible from the moment the renderer target appears, saving PNG frames to
// the output directory. Used to detect the "black window" frame shown during
// app startup before the UI paints.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CDP_HTTP_PORT = Number(process.env.CDP_PORT || '9222');
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'frames');
const DURATION_MS = Number(process.env.DURATION_MS || '60000');
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS || '40');
const TARGET_URL_FILTER = process.env.TARGET_URL_FILTER || '';

mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function waitForTarget() {
  const deadline = Date.now() + DURATION_MS;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_HTTP_PORT}/json`);
      const targets = Array.isArray(list) ? list : [];
      for (const target of targets) {
        if (target.type !== 'page') continue;
        if (TARGET_URL_FILTER && !target.url.includes(TARGET_URL_FILTER)) continue;
        return target;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('No page target appeared in time');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve(client);
    ws.onerror = (e) => reject(new Error('websocket error'));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    const client = {
      send(method, params = {}) {
        const msgId = ++id;
        return new Promise((resolveMsg, rejectMsg) => {
          pending.set(msgId, { resolve: resolveMsg, reject: rejectMsg });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close() {
        try {
          ws.close();
        } catch {}
      },
    };
  });
}

let frameIndex = 0;
async function main() {
  const target = await waitForTarget();
  console.error(`[frames] target: ${target.url}`);
  const ws = await connect(target.webSocketDebuggerUrl);
  // Start capturing immediately; Page.enable is fire-and-forget.
  const enablePromise = ws.send('Page.enable').catch(() => {});
  void ws.send('Runtime.enable').catch(() => {});

  const startedAt = Date.now();
  const endAt = startedAt + DURATION_MS;
  while (Date.now() < endAt) {
    const t0 = Date.now();
    try {
      const { data } = await ws.send('Page.captureScreenshot', { format: 'png' });
      const rel = Date.now() - startedAt;
      const name = `frame-${String(frameIndex).padStart(5, '0')}-t${rel}ms.png`;
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(data, 'base64'));
      frameIndex += 1;
    } catch (e) {
      console.error(`[frames] capture error: ${e.message}`);
    }
    const elapsed = Date.now() - t0;
    if (elapsed < CAPTURE_INTERVAL_MS) {
      await sleep(CAPTURE_INTERVAL_MS - elapsed);
    }
  }
  ws.close();
  console.error(`[frames] captured ${frameIndex} frames to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error('[frames] fatal:', e.message);
  process.exit(1);
});
