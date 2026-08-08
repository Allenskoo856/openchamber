#!/usr/bin/env node
// Deterministic reproduction of the startup black window (issue #2762).
//
// Replicates the OpenChamber Electron startup flow from packages/electron/main.mjs:
//   1. createBrowserWindow() creates the main window with `show: false` and
//      `backgroundColor: '#151313'` (near-black, non-darwin) and navigates to
//      the startup splash (data: URL).
//   2. activateMainWindow() then does `await navigateWindow(mainWindow, url)`
//      followed by `mainWindow.show()` -- i.e. the window is shown after
//      did-finish-load, NOT after the renderer's first paint.
//
// The real-UI page used here paints nothing for several seconds after
// did-finish-load. That reproduces the user-visible symptom: the window is
// shown while the compositor only has the backgroundColor (#151313) to
// display, so the user sees a black window before the UI content renders.
import { app, BrowserWindow, desktopCapturer } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'black-frames');
mkdirSync(OUT_DIR, { recursive: true });

const MODE = process.env.REPRO_MODE || 'full';
const PAINT_DELAY_MS = Number(process.env.REPRO_PAINT_DELAY_MS || '4000');
const SPLASH_PAINT_DELAY_MS = Number(process.env.REPRO_SPLASH_PAINT_DELAY_MS || '0');

// The window options from createBrowserWindow() in main.mjs (non-darwin path):
// frameless, hidden title bar, show:false, backgroundColor '#151313'.
const browserWindowOptions = {
  title: 'OpenChamber',
  width: 1280,
  height: 800,
  minWidth: 800,
  minHeight: 520,
  show: false,
  backgroundColor: '#151313',
  frame: false,
  autoHideMenuBar: true,
  titleBarStyle: 'hidden',
  titleBarOverlay: false,
  webPreferences: {
    backgroundThrottling: false,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: true,
    sandbox: false,
  },
};

// Minimal version of buildStartupSplashHtml() from main.mjs (dark splash).
const splashHtml = `<!doctype html><html><head><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: #0c0a09; }
  svg { width: 120px; height: 120px; }
  path { stroke: #fafaf9; }
</style><script>
  // Optional delay of the splash first paint (used to force the abort path:
  // the real-UI navigation cancels the splash before it ever paints).
  const d = ${SPLASH_PAINT_DELAY_MS};
  if (d > 0) {
    const t0 = performance.now();
    while (performance.now() - t0 < d) {}
  }
</script></head><body>
  <svg viewBox="0 0 100 100" fill="none">
    <path d="M50 50 L8.432 26 L8.432 74 L50 98 Z" fill="rgba(255,255,255,0.15)" stroke-width="2"/>
    <path d="M50 50 L91.568 26 L91.568 74 L50 98 Z" fill="rgba(255,255,255,0.15)" stroke-width="2"/>
    <path d="M50 2 L8.432 26 L50 50 L91.568 26 Z" stroke-width="2"/>
  </svg>
  <script>
    window.__OC_SPLASH_LOADED__ = true;
  </script>
</body></html>`;

// Real UI page: paints nothing for PAINT_DELAY_MS after did-finish-load, then
// paints actual content. During the delay the compositor has no frame of its
// own and the window shows its backgroundColor (#151313, near-black).
const realUiHtml = (delayMs) => `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; background: transparent; }
  body { background: transparent; }
  #content { display: none; }
</style></head><body>
  <div id="content" style="position:fixed;inset:0;background:#fffcf0;color:#1c1917;font-family:system-ui;padding:40px;">
    <h1>OpenChamber UI</h1>
    <p>Application content rendered.</p>
  </div>
  <script>
    // did-finish-load fires as soon as the load event completes; the actual
    // first paint of the "UI" is postponed by PAINT_DELAY_MS so that a
    // show() issued right after load runs while nothing has been painted yet.
    setTimeout(() => {
      const t0 = performance.now();
      while (performance.now() - t0 < ${delayMs}) {}
      const content = document.getElementById('content');
      content.style.display = 'block';
      window.__OC_UI_PAINTED_AT__ = Math.round(performance.now());
    }, 0);
  </script>
</body></html>`;

const encode = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

let frameIndex = 0;
const captures = [];

async function capture(win, label) {
  try {
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    const name = `${String(frameIndex).padStart(4, '0')}-${label}.png`;
    writeFileSync(path.join(OUT_DIR, name), png);
    frameIndex += 1;
    captures.push({ label, at: Date.now() });
    return name;
  } catch (error) {
    console.error(`[repro] capture failed (${label}): ${error.message}`);
    return null;
  }
}

async function captureScreen(label) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 } });
    const primary = sources[0];
    if (!primary?.thumbnail?.isEmpty()) {
      const name = `${String(frameIndex).padStart(4, '0')}-screen-${label}.png`;
      writeFileSync(path.join(OUT_DIR, name), primary.thumbnail.toPNG());
      frameIndex += 1;
      console.log(`[repro] screen capture ${label}: saved ${name}`);
    } else {
      console.log(`[repro] screen capture ${label}: empty thumbnail`);
    }
  } catch (error) {
    console.error(`[repro] screen capture failed (${label}):`, error.message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isBenignNavigationAbort = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.errno === -3) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return message.includes('ERR_ABORTED') || message.includes(' (-3) loading ');
};

const loadUrlAllowAbort = async (win, url) => {
  try {
    await win.loadURL(url);
  } catch (error) {
    if (isBenignNavigationAbort(error)) return;
    throw error;
  }
};

app.whenReady().then(async () => {
  // Warm up desktopCapturer so the later screen capture during the black
  // window is timely (the first getSources() call is slow).
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 32, height: 32 } });
  } catch {}

  const win = new BrowserWindow(browserWindowOptions);
  const startedAt = Date.now();
  console.log(`[repro] mode=${MODE} paintDelay=${PAINT_DELAY_MS}ms windowCreated`);

  win.webContents.on('dom-ready', () => {
    console.log(`[repro] t+${Date.now() - startedAt}ms dom-ready url=${String(win.webContents.getURL()).slice(0, 30)}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`[repro] t+${Date.now() - startedAt}ms did-finish-load url=${String(win.webContents.getURL()).slice(0, 30)}`);
  });

  if (MODE === 'show-after-load') {
    // The activateMainWindow() pattern: await loadURL, then show().
    await loadUrlAllowAbort(win, encode(realUiHtml(PAINT_DELAY_MS)));
    console.log(`[repro] t+${Date.now() - startedAt}ms loadURL resolved -> show() (renderer has not painted yet)`);
    win.show();
    win.focus();
  } else {
    // Full startup flow: splash first, ready-to-show shows it, then the real UI.
    win.once('ready-to-show', () => {
      console.log(`[repro] t+${Date.now() - startedAt}ms ready-to-show -> show() splash`);
      win.show();
    });
    void loadUrlAllowAbort(win, encode(splashHtml));
    // resolveInitialUrl() is fast in the repro (like a warm server), so the
    // splash navigation is usually aborted before first paint.
    await sleep(30);
    await loadUrlAllowAbort(win, encode(realUiHtml(PAINT_DELAY_MS)));
    console.log(`[repro] t+${Date.now() - startedAt}ms loadURL(realUi) resolved -> show()`);
    win.show();
    win.focus();
  }

  // Sample the composited view around the show-before-paint window.
  for (const delay of [0, 300, 800, 2000]) {
    await sleep(delay);
    const t = Date.now() - startedAt;
    await captureScreen(`t${t}ms`);
    const name = await capture(win, `t${t}ms`);
    let paintedAt = null;
    try {
      paintedAt = await win.webContents.executeJavaScript('window.__OC_UI_PAINTED_AT__ ?? null');
    } catch {}
    console.log(`[repro] t+${t}ms capture=${name ?? 'FAILED (no frame -> window shows backgroundColor)'} paintedAt=${paintedAt ?? 'not-yet'}`);
  }
  await sleep(PAINT_DELAY_MS + 1500);
  const name = await capture(win, 'after-paint');
  let paintedAt = null;
  try {
    paintedAt = await win.webContents.executeJavaScript('window.__OC_UI_PAINTED_AT__ ?? null');
  } catch {}
  console.log(`[repro] t+${Date.now() - startedAt}ms capture=${name ?? 'FAILED'} paintedAt=${paintedAt ?? 'not-yet'}`);

  console.log('[repro] done. frames written to', OUT_DIR);
  app.quit();
}).catch((error) => {
  console.error('[repro] fatal:', error);
  app.exit(1);
});
