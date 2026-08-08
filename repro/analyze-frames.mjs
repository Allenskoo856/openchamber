#!/usr/bin/env node
// Analyze captured startup frames: classify each frame and report the sequence.
//
// Classification:
//  - "black"   : uniformly dark (mean luminance < 12), essentially no bright
//                pixels (< 0.3% of pixels above luminance 60). This is the
//                window backgroundColor (#151313) shown with no content painted
//                -- the reported black-window frame.
//  - "splash"  : dark background but with a visible light logo/stroke.
//  - "loading" : the web UI #initial-loading screen (#151313 bg + logo).
//  - "ui"      : light content present (UI painted).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = process.argv[2] || 'repro/frames';
const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();

function classify(stats, width, height) {
  const { mean, brightFraction } = stats;
  const total = width * height;
  if (brightFraction < 0.003 && mean < 12) return 'black';
  if (mean < 45) return 'dark-content'; // splash / loading screen / dark UI
  return 'ui';
}

async function main() {
  const rows = [];
  for (const file of files) {
    const img = sharp(path.join(dir, file));
    const meta = await img.metadata();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < n; i += 1) {
      const r = data[i * info.channels];
      const g = data[i * info.channels + 1];
      const b = data[i * info.channels + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      if (lum > 60) bright += 1;
    }
    const mean = sum / n;
    const brightFraction = bright / n;
    const kind = classify({ mean, brightFraction }, info.width, info.height);
    const t = file.match(/t(\d+)ms/)?.[1] ?? '?';
    rows.push({ file, t: Number(t), mean: mean.toFixed(1), brightPct: (brightFraction * 100).toFixed(3), kind });
  }

  // Print the sequence, compacting consecutive runs of the same kind.
  let lastKind = '';
  let runStart = null;
  const runs = [];
  for (const row of rows) {
    if (row.kind !== lastKind) {
      if (runStart) runs[runStart.kind].end = runStart.t;
      runStart = { kind: row.kind, t: row.t };
      runs[runStart.kind] = runStart;
    }
    if (row.kind === 'black') {
      // record all black frames explicitly
      if (!rows.black) rows.black = [];
      rows.black.push(row);
    }
    lastKind = row.kind;
  }
  if (runStart) runs[runStart.kind].end = lastKind === runStart.kind ? (rows.at(-1)?.t ?? runStart.t) : runStart.t;

  console.log('=== frame sequence (kind: t0 -> t1) ===');
  for (const [kind, r] of Object.entries(runs)) {
    console.log(`${kind.padEnd(14)} ${String(r.t).padStart(6)}ms -> ${String(r.end).padStart(6)}ms`);
  }
  console.log('\n=== black (background-only) frames ===');
  const blackRows = rows.filter((r) => r.kind === 'black');
  if (blackRows.length === 0) {
    console.log('(none)');
  } else {
    for (const r of blackRows) {
      console.log(`${r.file}  meanLum=${r.mean} brightPct=${r.brightPct}`);
    }
  }
  const firstBlack = blackRows[0];
  const lastBlack = blackRows.at(-1);
  if (firstBlack) {
    console.log(`\nblack window shown from t=${firstBlack.t}ms to t=${lastBlack.t}ms (${lastBlack.t - firstBlack.t}ms)`);
  }
}

main().catch((e) => {
  console.error('analyze failed:', e);
  process.exit(1);
});
