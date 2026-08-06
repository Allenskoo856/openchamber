/**
 * Measurement harness for the Issue #2712 reproduction fixture.
 *
 * Renders repro/issue-2712/fixture.html in headless Chromium and reports the
 * footer row geometry for both the narrow bubble (repro case) and the wide
 * bubble (control). Requires `google-chrome`/`chromium` on PATH.
 *
 * Run:  node repro/issue-2712/measure.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file://${path.join(dir, 'fixture.html')}`;

const chrome = (() => {
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable']) {
    try {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return name;
    } catch { /* ignore */ }
  }
  return 'google-chrome';
})();

const run = () => new Promise((resolve, reject) => {
  const p = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--virtual-time-budget=5000',
    '--dump-dom',
    fixtureUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', () => {});
  p.on('error', reject);
  p.on('close', () => {
    const m = out.match(/<div id="results"[^>]*>(.*?)<\/div>/s);
    resolve(m ? m[1].replace(/&quot;/g, '"') : null);
  });
});

const raw = await run();
if (!raw) {
  console.error('No measurement output (is Chromium installed?).');
  process.exit(1);
}
const data = JSON.parse(raw);

console.log('Narrow bubble (one-word message) — repro case:');
console.log(JSON.stringify(data.narrowBubble, null, 2));
console.log('\nWide bubble (>= ~235px) — control:');
console.log(JSON.stringify(data.wideBubbleControl, null, 2));

const narrow = data.narrowBubble;
const wide = data.wideBubbleControl;
const bugReproduced =
  narrow.timestampLabelLineCount > 1 &&
  narrow.actionRow.height > wide.actionRow.height;

console.log('\nRESULT:', bugReproduced ? 'BUG REPRODUCED' : 'not reproduced');
if (bugReproduced) {
  console.log('The timestamp label wraps to', narrow.timestampLabelLineCount,
    'lines and the footer row is', narrow.actionRow.height + 'px',
    'tall (vs', wide.actionRow.height + 'px', 'on a wide bubble).');
  if (narrow.footerOverlapsFollow) {
    console.log('The absolutely-positioned footer overlaps the message content below it.');
  }
}
process.exit(bugReproduced ? 0 : 1);
