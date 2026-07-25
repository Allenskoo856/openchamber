import { describe, expect, it } from 'bun:test';
import { detectClaudeCode, detectHarness, detectOpenCode } from './detect.js';

describe('harness detect', () => {
  it('reports missing-cli when claude binary is absent', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => null,
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('missing-cli');
    expect(result.sections).toEqual([]);
    expect(result.statusDetail).toMatch(/not found/i);
  });

  it('does not return ready with empty sections on SDK failure', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: false, error: 'import failed' }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('error');
    expect(result.sections).toEqual([]);
    expect(result.status).not.toBe('ready');
  });

  it('reports needs-login when credentials are absent', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: false, detail: 'no-credentials-file' }),
    });

    expect(result.status).toBe('needs-login');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
  });

  it('returns ready only when binary, SDK, and login succeed', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('ready');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
  });

  it('detects OpenCode ready/error without empty-ready masquerade', () => {
    expect(detectOpenCode({ openCodeReady: true }).status).toBe('ready');
    expect(detectOpenCode({ openCodeReady: false }).status).toBe('error');
  });

  it('returns null for unknown harness ids', async () => {
    expect(await detectHarness('nope')).toBeNull();
  });
});
