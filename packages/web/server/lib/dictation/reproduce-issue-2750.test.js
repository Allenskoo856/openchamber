/**
 * Reproduction for issue #2750 — "Insufficient error reporting and logging".
 *
 * Reported symptom: when the local dictation model download fails (e.g.
 * "tar errocode 2"), the failure is shown in the UI but leaves no trace in
 * the server/docker logs.
 *
 * This test forces a real model download where the archive is garbage, so
 * system `tar` fails with exit code 2. It then verifies:
 *   1. the failure IS surfaced through the UI-facing status/session APIs
 *      (`reasonCode: 'model_download_failed'`, "tar exited with code 2"), and
 *   2. the server writes NOTHING to the console/log during the whole
 *      download + failure cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import { createDictationService } from './service.js';

function captureConsole() {
  const captured = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = {};
  for (const method of methods) {
    originals[method] = console[method];
    console[method] = (...args) => {
      captured.push(`${method}: ${args.map(String).join(' ')}`);
    };
  }
  return {
    captured,
    restore() {
      for (const method of methods) {
        console[method] = originals[method];
      }
    },
  };
}

// A "successful" HTTP download whose body is not a valid tar archive, so
// `tar xf` fails with exit code 2 (GNU tar).
function garbageArchiveResponse() {
  const bytes = Buffer.from(
    'this is not a tar archive, just plain text — tar will exit with code 2',
    'utf8',
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name) =>
        String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null,
    },
    body: stream,
  };
}

async function waitFor(predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('reproduce #2750: dictation model download failure is not logged', () => {
  let modelsDir;
  let originalFetch;
  let capture;
  let consoleOutput;

  beforeAll(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'oc-speech-models-'));
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => garbageArchiveResponse();
  });

  afterAll(async () => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    await rm(modelsDir, { recursive: true, force: true }).catch(() => undefined);
    capture?.restore();
  });

  it('surfaces "tar exited with code 2" to the UI but writes nothing to the server log', async () => {
    const service = createDictationService({ modelsDir });
    capture = captureConsole();

    try {
      // First use auto-starts the background model download.
      const first = await service.createSttSession({});
      expect(first.reasonCode).toBe('model_download_in_progress');

      // Wait for the background download to fail (tar exit code 2).
      let status;
      await waitFor(async () => {
        status = await service.getStatus({});
        const active = status.models?.find((model) => model.id === status.activeModel);
        return active?.downloadError != null;
      });

      // 1. The failure IS visible to the UI (what the reporter sees).
      expect(status.reasonCode).toBe('model_download_failed');
      expect(status.error).toContain('tar exited with code 2');

      // A later attempt also reports the error to the client session.
      const retry = await service.createSttSession({});
      expect(retry.reasonCode).toBe('model_download_failed');
      expect(retry.error).toContain('tar exited with code 2');

      // 2. ...but the server log is completely silent. No console.log /
      //    console.error / console.warn was emitted by the download path.
      consoleOutput = capture.captured;
      expect(consoleOutput).toEqual([]);
    } finally {
      capture.restore();
      service.shutdown();
    }
  });
});
