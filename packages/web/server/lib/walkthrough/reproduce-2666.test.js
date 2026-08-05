import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Reproduction for https://github.com/openchamber/openchamber/issues/2666
// "[Bug] Custom plugin-backed company LLM models fail in Changes Walkthrough
// generation"
//
// A custom OpenCode plugin registers an internal provider (company LLM API) and
// its models at runtime. The plugin owns auth, proxy, protocol conversion and a
// custom fetch — there is deliberately NO `provider.<id>.options.baseURL` in
// the config and the provider is NOT part of the models.dev catalog.
//
// Normal OpenCode chat routes through the plugin and works. The walkthrough,
// however, generates through the server-side small-model chain
// (callSmallModel), which resolves the base URL only from the config, the
// hardcoded openai endpoint, or the models.dev catalog. None of those know the
// plugin's provider, so regeneration fails with:
//
//   Provider "custom-provider" has no known API base URL
//
// Readiness does not catch it either: the provider HAS a usable auth entry, so
// `hasLogin` is true and the panel shows ready, letting the user click
// Generate/Regenerate before the raw error surfaces.
// ---------------------------------------------------------------------------

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-2666-'));
process.env.HOME = TEMP_HOME;
process.env.OPENCHAMBER_DATA_DIR = path.join(TEMP_HOME, '.config', 'openchamber');

// The plugin provider is not in the models.dev catalog.
const CATALOG = {};

vi.mock('../../opencode/models-metadata.js', () => ({
  getModelsMetadata: vi.fn(async () => ({ metadata: CATALOG, fromCache: false })),
}));

const SOURCE = { kind: 'working-tree', scope: 'all' };
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-2666-'));

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
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
};

let walkthrough;
let callSmallModel;

describe('issue 2666 — plugin-backed provider has no base URL in walkthrough generation', () => {
  beforeAll(async () => {
    setupGitRepo();

    // The plugin's login is persisted in auth.json, exactly like a provider the
    // plugin registered with an apiKey option. The plugin does the actual HTTP
    // work, so no `provider.custom-provider.options.baseURL` exists anywhere.
    const authDir = path.join(TEMP_HOME, '.local', 'share', 'opencode');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({ 'custom-provider': { type: 'api', key: 'company-key-123' } }, null, 2),
      'utf8',
    );

    // Project config exists but says nothing about the plugin provider — there
    // is no base URL to read. (An empty config also reproduces; this mirrors a
    // real project that has its own unrelated opencode.json.)
    fs.writeFileSync(path.join(REPO_DIR, 'opencode.json'), '{}', 'utf8');

    walkthrough = await import('./index.js');
    callSmallModel = await import('../small-model/call.js');
  });

  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  });

  it('readiness reports the plugin model as ready (no blocker catches the missing base URL)', async () => {
    const result = await walkthrough.getWalkthrough({
      directory: REPO_DIR,
      source: SOURCE,
      model: 'custom-provider/custom-model',
    });

    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.reason).toBeUndefined();
    expect(result.readiness.model).toMatchObject({
      providerID: 'custom-provider',
      modelID: 'custom-model',
    });
  });

  it('callSmallModel throws the exact reported error for a plugin provider', async () => {
    const error = await callSmallModel.callSmallModel({
      auth: { 'custom-provider': { type: 'api', key: 'company-key-123' } },
      catalog: CATALOG,
      workingDirectory: REPO_DIR,
      providerID: 'custom-provider',
      modelID: 'custom-model',
      prompt: 'x',
    }).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Provider "custom-provider" has no known API base URL');
    // Raw 500-style error: no structured code the UI can turn into a blocker.
    expect(error.code).toBeUndefined();
    expect(error.statusCode).toBeUndefined();
  });

  it('generateWalkthrough rejects with the raw no-base-URL error', async () => {
    const error = await walkthrough.generateWalkthrough({
      directory: REPO_DIR,
      source: SOURCE,
      force: true,
      model: 'custom-provider/custom-model',
    }).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Provider "custom-provider" has no known API base URL');
  });

  it('answers the generate route with HTTP 500 and the raw message', async () => {
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
        body: JSON.stringify({
          directory: REPO_DIR,
          source: SOURCE,
          force: true,
          model: 'custom-provider/custom-model',
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Provider "custom-provider" has no known API base URL');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
