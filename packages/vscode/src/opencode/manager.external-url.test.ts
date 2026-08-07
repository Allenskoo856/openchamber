// @ts-nocheck
import { afterEach, beforeEach, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

const getConfiguration = mock(() => ({
  get: (key: string) => {
    if (key === 'apiUrl') return 'http://127.0.0.1:5555/';
    if (key === 'opencodeBinary') return '';
    return '';
  },
}));

mock.module('vscode', () => ({
  l10n: { t: (value: string) => value },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: '/workspace' } }];
    },
    getConfiguration: getConfiguration,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
    }),
    showErrorMessage: async () => undefined,
  },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  env: { openExternal: async () => true },
  commands: { executeCommand: async () => undefined },
  Disposable: class {
    constructor(private readonly disposeFn: () => void) {}
    dispose() {
      this.disposeFn();
    }
  },
}));

const { createOpenCodeManager } = await import('./manager');

describe('external configured apiUrl startup', () => {
  beforeEach(() => {
    getConfiguration.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('probes health before marking connected', async () => {
    let healthChecks = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/global/health')) {
        healthChecks += 1;
        return new Response(JSON.stringify({ healthy: true, version: '1.18.8' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const context = {
      globalStorageUri: { fsPath: '/tmp/openchamber-global-storage' },
    };

    const manager = createOpenCodeManager(context);
    const statuses: string[] = [];
    manager.onStatusChange((status) => {
      statuses.push(status);
    });

    await manager.start();

    assert.equal(healthChecks > 0, true);
    assert.equal(manager.getStatus(), 'connected');
    assert.ok(statuses.includes('connecting'));
    assert.equal(statuses.at(-1), 'connected');
  });
});
