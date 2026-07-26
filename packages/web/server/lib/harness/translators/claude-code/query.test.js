import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClaudeQuery } from './query.js';

describe('startClaudeQuery effort option', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('forwards effort to the Claude Agent SDK query options', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-effort-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });

    expect(seenOptions).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      cwd: tempDir,
    });
    await handle.close?.();
  });
});
