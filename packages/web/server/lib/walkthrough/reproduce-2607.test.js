import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Reproduction for https://github.com/openchamber/openchamber/issues/2607
// "[Bug] Why say so?" (walkthrough panel)
//
// The screenshot shows the Walkthrough panel with a "generate walkthrough"
// button, a model picker showing "DeepSeek V4 Flash", an error banner reading
// `No OpenCode login found for provider "deepseek"`, and the empty state
// "No walkthrough yet" below it.
//
// This test reproduces the exact server-side chain that produces that screen:
//   1. The walkthrough small model is resolved from the repo's opencode.json
//      (`small_model: "deepseek/deepseek-v4-flash"`) — resolution does not
//      require a login, so the panel reports the request "ready".
//   2. The provider has no OpenCode login (no auth.json entry, no
//      provider.deepseek.options.apiKey), so clicking generate throws the raw
//      error `No OpenCode login found for provider "deepseek"`.
//   3. The error carries no statusCode/code, so the route answers HTTP 500 and
//      the raw, developer-oriented message is shown verbatim in the UI banner
//      while the panel body still reads "No walkthrough yet".
// ---------------------------------------------------------------------------

// Isolate HOME + OpenChamber data so no real OpenCode auth/config leaks in.
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-2607-'));
process.env.HOME = TEMP_HOME;
process.env.OPENCHAMBER_DATA_DIR = path.join(TEMP_HOME, '.config', 'openchamber');

// A minimal models.dev catalog containing the deepseek provider/model shown in
// the issue screenshot. No network access needed.
const CATALOG = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: 'deepseek-flash',
        limit: { context: 128_000 },
      },
    },
  },
};

vi.mock('../../opencode/models-metadata.js', () => ({
  getModelsMetadata: vi.fn(async () => ({ metadata: CATALOG, fromCache: false })),
}));

const SOURCE = { kind: 'working-tree', scope: 'all' };
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-2607-'));

const setupGitRepo = () => {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
    } catch (error) {
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.toString() ?? error.message}`);
    }
  };

  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  run(['add', 'src/a.ts']);
  run(['commit', '-m', 'init']);
  // Uncommitted change so there is something to review.
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
};

let walkthrough;
let callSmallModel;

describe('issue 2607 — walkthrough surfaces raw "No OpenCode login found for provider" error', () => {
  beforeAll(async () => {
    setupGitRepo();
    // Configure the walkthrough small model the same way the screenshot's user
    // did: a deepseek model picked even though the provider has no login.
    fs.writeFileSync(
      path.join(REPO_DIR, 'opencode.json'),
      JSON.stringify({ small_model: 'deepseek/deepseek-v4-flash' }, null, 2),
      'utf8',
    );

    walkthrough = await import('./index.js');
    callSmallModel = await import('../small-model/call.js');
  });

  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  });

  it('resolves the deepseek model and reports the walkthrough "ready" despite no login', async () => {
    const result = await walkthrough.getWalkthrough({ directory: REPO_DIR, source: SOURCE });

    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.model).toMatchObject({ providerID: 'deepseek', modelID: 'deepseek-v4-flash' });
    expect(result.readiness.reason).toBeUndefined();
  });

  it('thrown exactly as the real callSmallModel throws: raw message, no code, no statusCode', async () => {
    // Prove the error source first: with no auth entry and no provider config
    // apiKey, callSmallModel throws the raw Error shown in the screenshot.
    await expect(callSmallModel.callSmallModel({
      auth: {},
      catalog: CATALOG,
      workingDirectory: REPO_DIR,
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
      prompt: 'x',
    })).rejects.toThrow('No OpenCode login found for provider "deepseek"');
  });

  it('generateWalkthrough rejects with the raw message shown in the screenshot', async () => {
    const error = await walkthrough.generateWalkthrough({ directory: REPO_DIR, source: SOURCE })
      .then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('No OpenCode login found for provider "deepseek"');
    // No structured code, so the UI cannot turn it into a blocker; it renders
    // the raw message in the error banner instead.
    expect(error.code).toBeUndefined();
    expect(error.statusCode).toBeUndefined();
  });

  it('answers the generate route with HTTP 500 and the raw message verbatim', async () => {
    const service = { ...walkthrough, getPullRequestDiff: async () => { throw new Error('not used'); } };
    const app = express();
    app.use(express.json());
    const { registerWalkthroughRoutes } = await import('./routes.js');
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => service });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/api/walkthrough/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: REPO_DIR, source: SOURCE }),
      });
      const body = await response.json();

      // Status 500 (the raw Error has no statusCode), and the message the UI
      // banner displays is exactly what the issue screenshot shows.
      expect(response.status).toBe(500);
      expect(body.error).toBe('No OpenCode login found for provider "deepseek"');
      expect(body.code).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
