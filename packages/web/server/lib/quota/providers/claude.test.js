import { describe, expect, it } from 'bun:test';
import { mapClaudeUsageWindows, providerName } from './claude.js';

describe('claude quota provider', () => {
  it('labels the provider as Claude subscription usage', () => {
    expect(providerName).toBe('Claude subscription');
  });

  it('maps Anthropic oauth usage windows without inventing data', () => {
    const windows = mapClaudeUsageWindows({
      five_hour: { utilization: 12.5, resets_at: '2026-07-25T12:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-08-01T00:00:00Z' },
    });

    expect(windows['5h']?.usedPercent).toBe(12.5);
    expect(windows['7d']?.usedPercent).toBe(40);
    expect(windows['7d-sonnet']).toBeUndefined();
  });

  it('returns an empty window map for empty payloads', () => {
    expect(mapClaudeUsageWindows(null)).toEqual({});
    expect(mapClaudeUsageWindows({})).toEqual({});
  });
});
