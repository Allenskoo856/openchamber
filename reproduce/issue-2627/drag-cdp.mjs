#!/usr/bin/env node
/**
 * Browser-level reproduction for issue #2627 - "File tree only expands at
 * depth 1" (macOS desktop, v1.18.0).
 *
 * Demonstrates that a `draggable` folder row button (the FileRow markup in
 * `SidebarFilesTree.tsx`) suppresses its `click` handler when the pointer
 * moves a few pixels between mousedown and mouseup, because the browser
 * starts a drag-and-drop gesture instead. The non-draggable row button
 * (the control, matching `FilesView.tsx`) still receives the click.
 *
 * On macOS trackpads / Magic Mouse this is the normal behaviour, so folder
 * clicks in the sidebar file tree frequently do nothing - directories never
 * expand, giving the impression that only the first layer works.
 *
 * Usage:
 *   node reproduce/issue-2627/drag-cdp.mjs
 *
 * Requires a Chromium-compatible browser (default /usr/bin/chromium, or set
 * CHROME_BIN). Drives real input events over the Chrome DevTools Protocol.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = 9333;
const PAGE_URL = 'file://' + join(__dirname, 'drag-suppression.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=/tmp/openchamber-issue-2627-profile',
    PAGE_URL,
  ], { stdio: 'ignore' });

  try {
    let version;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`);
        version = await res.json();
        if (version.length > 0) break;
      } catch { /* retry */ }
      await sleep(200);
    }
    if (!version || version.length === 0) throw new Error('Chrome devtools endpoint not reachable');

    const page = version.find((t) => t.type === 'page') || version[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    for (let i = 0; i < 50; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result?.result?.value === 'complete') break;
      await sleep(200);
    }
    await sleep(500);

    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      return r.result?.result?.value;
    };
    const rectOf = async (id) => {
      const r = await evalJs(`(() => { const el = document.getElementById('${id}'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      return r;
    };
    const mouse = (type, x, y, opts = {}) =>
      send('Input.dispatchMouseEvent', {
        type, x, y, button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1,
        buttons: opts.buttons ?? (type === 'mouseMoved' ? 1 : 0),
      });

    const d = await rectOf('draggable');
    const p = await rectOf('plain');

    let reproduced = false;
    for (const dist of [2, 3, 4, 6, 8]) {
      await evalJs('window.clickCounts = { draggable: 0, plain: 0 }; window.dragCounts = { draggable: 0, plain: 0 };');

      await mouse('mousePressed', d.x, d.y, { clickCount: 1 });
      await mouse('mouseMoved', d.x + dist, d.y + dist);
      await mouse('mouseReleased', d.x + dist, d.y + dist);
      await sleep(250);
      const da = JSON.parse(await evalJs('window.__state()'));

      await mouse('mousePressed', p.x, p.y, { clickCount: 1 });
      await mouse('mouseMoved', p.x + dist, p.y + dist);
      await mouse('mouseReleased', p.x + dist, p.y + dist);
      await sleep(250);
      const pb = JSON.parse(await evalJs('window.__state()'));

      const row = {
        dist,
        draggable: { click: da.clickCounts.draggable, drag: da.dragCounts.draggable },
        plain: { click: pb.clickCounts.plain, drag: pb.dragCounts.plain },
      };
      console.log(JSON.stringify(row));

      if (row.draggable.click === 0 && row.draggable.drag === 1 && row.plain.click === 1) {
        reproduced = true;
      }
    }

    console.log(reproduced
      ? 'REPRODUCED: on >=4px pointer movement the draggable folder row suppresses its click (drag starts instead), while the plain row still clicks.'
      : 'NOT REPRODUCED');
    process.exitCode = reproduced ? 0 : 1;
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
