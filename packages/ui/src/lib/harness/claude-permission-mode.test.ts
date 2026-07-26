import { describe, expect, test } from 'bun:test';
import { claudePermissionModeFromEditPermission } from './claude-permission-mode';

describe('claudePermissionModeFromEditPermission', () => {
  test('maps allow → acceptEdits', () => {
    expect(claudePermissionModeFromEditPermission('allow')).toBe('acceptEdits');
  });

  test('maps ask → default', () => {
    expect(claudePermissionModeFromEditPermission('ask')).toBe('default');
  });

  test('maps deny → plan', () => {
    expect(claudePermissionModeFromEditPermission('deny')).toBe('plan');
  });

  test('defaults missing → default', () => {
    expect(claudePermissionModeFromEditPermission(undefined)).toBe('default');
  });
});
