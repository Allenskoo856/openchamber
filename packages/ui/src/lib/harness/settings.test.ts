import { describe, expect, test } from 'bun:test';

import {
  ENGINES_SETTINGS_DEFAULTS,
  sanitizeEnginesSettings,
  withEnginesSettingsDefaults,
} from './settings';

describe('sanitizeEnginesSettings', () => {
  test('keeps valid harness id and booleans', () => {
    expect(sanitizeEnginesSettings({
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
      enginesClaudeCodeEnabled: true,
    })).toEqual({
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
      enginesClaudeCodeEnabled: true,
    });
  });

  test('invalid harness id falls back to opencode', () => {
    expect(sanitizeEnginesSettings({
      enginesDefaultHarnessId: 'codex-cli',
    })).toEqual({
      enginesDefaultHarnessId: 'opencode',
    });
  });

  test('omits wrong-typed boolean fields', () => {
    expect(sanitizeEnginesSettings({
      enginesClaudeCodeWarnOnOpenCodeHandoff: 'yes',
      enginesClaudeCodeEnabled: 1,
    })).toEqual({});
  });

  test('omits missing fields', () => {
    expect(sanitizeEnginesSettings({})).toEqual({});
  });
});

describe('withEnginesSettingsDefaults', () => {
  test('applies product defaults when empty', () => {
    expect(withEnginesSettingsDefaults(undefined)).toEqual(ENGINES_SETTINGS_DEFAULTS);
    expect(withEnginesSettingsDefaults({})).toEqual(ENGINES_SETTINGS_DEFAULTS);
  });

  test('preserves sanitized overrides', () => {
    expect(withEnginesSettingsDefaults({
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
    })).toEqual({
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
      enginesClaudeCodeEnabled: true,
    });
  });
});
