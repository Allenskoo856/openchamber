/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2769
 *
 * "[Bug] Shiki markdown highlight worker burns ~55% CPU continuously
 *  (sustained re-highlighting of existing content, not a single backtrack)"
 *
 * The trace the reporter attached shows the markdown-shiki worker pinned at
 * ~75% of one CPU core while the app is idle, re-tokenizing already-rendered
 * code blocks (~40 highlight results/second to the main thread). The two
 * mechanisms that allow unchanged content to be re-highlighted on every
 * re-render are reproduced here:
 *
 *  1. The per-block render cache in `markdownCore.ts`
 *     (`htmlCache`, CACHE_MAX=240) is keyed by `${cacheKey}:${index}:${mode}`.
 *     `SimpleMarkdownRenderer` builds `cacheKey` as `simple:${variant}`, so
 *     EVERY same-variant instance (tool outputs, user text parts, file
 *     previews ...) shares ONE cache slot. Two mounted same-variant renderers
 *     with different content evict each other on every render pass, so
 *     unchanged content is re-requested from the highlight worker every time —
 *     the "sustained re-highlighting" the trace records. The chat path uses
 *     per-part cacheKeys, but the LRU is capped at 240 entries for the whole
 *     app, so long sessions also thrash it.
 *
 *  2. The worker (`markdown-shiki.worker.ts`) performs NO caching at all:
 *     every `highlight` request calls `instance.codeToHtml(...)` again, even
 *     when the exact same source string was tokenized a moment ago.
 *
 * This test replicates the exact cache algorithm from markdownCore.ts
 * (lines 323-404) and the exact worker dispatch from markdown-shiki.worker.ts
 * (lines 75-88) to show both behaviors without needing a browser or worker.
 */
import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Verbatim replication of the cache logic in markdownCore.ts
// ---------------------------------------------------------------------------

const CACHE_MAX = 240;
const htmlCache = new Map<string, { hash: string; html: string }>();

// FNV-1a 32-bit hash of the block content. (markdownCore.ts lines 326-334)
const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const touch = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.delete(key);
  htmlCache.set(key, entry);
  if (htmlCache.size <= CACHE_MAX) return;
  const oldest = htmlCache.keys().next().value;
  if (oldest) htmlCache.delete(oldest);
};

// Mirrors renderMarkdownBlocks (markdownCore.ts lines 381-403): one block per
// message for non-streaming content (mode 'full', index 0). Returns true when
// the render required a worker highlight request (cache miss).
const renderBlock = (cacheKey: string, content: string): boolean => {
  const contentHash = hash(content);
  const key = `${cacheKey}:0:full`;
  const cached = htmlCache.get(key);
  if (cached && cached.hash === contentHash) {
    touch(key, cached);
    return false; // cache hit — no worker round-trip
  }
  touch(key, { hash: contentHash, html: `<pre>${content}</pre>` });
  return true; // cache miss — worker highlight request sent
};

// ---------------------------------------------------------------------------
// 1) Shared `simple:${variant}` cache key: same-variant SimpleMarkdownRenderer
//    instances evict each other, so unchanged content is re-highlighted on
//    every render pass.
// ---------------------------------------------------------------------------

describe('markdownCore htmlCache — SimpleMarkdownRenderer key collision', () => {
  test('two same-variant renderers with stable content never converge on a cache hit', () => {
    htmlCache.clear();

    // Two mounted SimpleMarkdownRenderer instances, variant="tool" (as used by
    // every tool output via `cacheKey: \`simple:${variant}\`` at
    // MarkdownRendererImpl.tsx line 1125). Content is COMPLETELY UNCHANGED
    // across the 100 simulated re-renders.
    const toolOutputA = '# tool A\n\n```ts\nconst a = 1;\n```';
    const toolOutputB = '# tool B\n\n```ts\nconst b = 2;\n```';

    let missesA = 0;
    let missesB = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      if (renderBlock('simple:tool', toolOutputA)) missesA += 1;
      if (renderBlock('simple:tool', toolOutputB)) missesB += 1;
    }

    // Unchanged content must not be re-requested. Every pass misses for BOTH
    // renderers because they share the single cache slot `simple:tool:0:full`.
    expect(missesA).toBe(100);
    expect(missesB).toBe(100);
  });

  test('long sessions (working set > 240 parts) re-highlight ALL unchanged content on every render pass', () => {
    htmlCache.clear();

    // Long session: 600 assistant text parts, each with its own cacheKey
    // (`markdown-part-<id>`), each containing a code block. Re-render every
    // part once per pass — content never changes.
    const parts = Array.from({ length: 600 }, (_, i) => ({
      key: `markdown-part-part_${i}`,
      content: `\`\`\`ts\nconst value_${i} = ${i};\n\`\`\``,
    }));

    const missesPerPass: number[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      let misses = 0;
      for (const part of parts) {
        if (renderBlock(part.key, part.content)) misses += 1;
      }
      missesPerPass.push(misses);
    }

    // The LRU (CACHE_MAX=240) is far smaller than the working set, so the
    // sequential iteration evicts every entry before it can be reused: each
    // pass misses 100% of the parts even though NONE of the content changed.
    // The worker is therefore asked to re-tokenize the same source on every
    // render — the sustained ~40 msg/s the trace records.
    for (const misses of missesPerPass) {
      expect(misses).toBe(parts.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) Worker-side: no cache, identical source re-tokenized on every request
// ---------------------------------------------------------------------------

// Mirrors markdown-shiki.worker.ts `highlight()` (lines 75-88): every request
// calls codeToHtml unconditionally. `ut` (codeToHtml) is the symbol burning
// 34.4% of the sampled CPU in the attached trace.
const workerCodeToHtmlCalls: string[] = [];
const workerHighlight = (code: string, lang: string): string => {
  workerCodeToHtmlCalls.push(`${lang}::${code}`);
  // In the real worker this is `instance.codeToHtml(code, { lang, theme })`
  // — a full grammar tokenization pass every single time.
  return `<pre><code>${code}</code></pre>`;
};

describe('markdown-shiki.worker — no result caching', () => {
  test('identical highlight requests always re-tokenize the same source', () => {
    workerCodeToHtmlCalls.length = 0;

    const code = 'const x = 1;\nconst y = 2;';
    // Simulates 10 identical highlight requests arriving from re-renders that
    // missed the main-thread htmlCache (see tests above).
    for (let i = 0; i < 10; i += 1) {
      workerHighlight(code, 'ts');
    }

    // Every request reached codeToHtml. There is no memoization keyed by the
    // source string in the worker, so N requests === N tokenizations.
    expect(workerCodeToHtmlCalls.length).toBe(10);
    expect(new Set(workerCodeToHtmlCalls).size).toBe(1);
  });
});
