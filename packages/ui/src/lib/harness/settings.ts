import type { HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

export type EnginesSettingsFields = {
  enginesDefaultHarnessId: HarnessId;
  enginesClaudeCodeWarnOnOpenCodeHandoff: boolean;
  enginesClaudeCodeEnabled: boolean;
};

export const ENGINES_SETTINGS_DEFAULTS: EnginesSettingsFields = {
  enginesDefaultHarnessId: 'opencode',
  enginesClaudeCodeWarnOnOpenCodeHandoff: true,
  enginesClaudeCodeEnabled: true,
};

/** In-memory mirror of the handoff billing warn toggle for send-path gates. */
let cachedWarnOnOpenCodeHandoff: boolean =
  ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeWarnOnOpenCodeHandoff;

export function getCachedWarnOnOpenCodeHandoff(): boolean {
  return cachedWarnOnOpenCodeHandoff;
}

export function setCachedWarnOnOpenCodeHandoff(enabled: boolean): void {
  cachedWarnOnOpenCodeHandoff = enabled;
}

export type SanitizedEnginesSettings = Partial<EnginesSettingsFields>;

/**
 * Sanitize persisted engines settings fields.
 * Invalid harness ids fall back to `opencode`. Wrong-typed booleans are omitted.
 */
export function sanitizeEnginesSettings(candidate: Record<string, unknown>): SanitizedEnginesSettings {
  const result: SanitizedEnginesSettings = {};

  if (candidate.enginesDefaultHarnessId !== undefined) {
    result.enginesDefaultHarnessId = isHarnessId(candidate.enginesDefaultHarnessId)
      ? candidate.enginesDefaultHarnessId
      : ENGINES_SETTINGS_DEFAULTS.enginesDefaultHarnessId;
  }

  if (typeof candidate.enginesClaudeCodeWarnOnOpenCodeHandoff === 'boolean') {
    result.enginesClaudeCodeWarnOnOpenCodeHandoff = candidate.enginesClaudeCodeWarnOnOpenCodeHandoff;
  }

  if (typeof candidate.enginesClaudeCodeEnabled === 'boolean') {
    result.enginesClaudeCodeEnabled = candidate.enginesClaudeCodeEnabled;
  }

  return result;
}

/** Fill missing engines settings with product defaults. */
export function withEnginesSettingsDefaults(
  partial: SanitizedEnginesSettings | null | undefined,
): EnginesSettingsFields {
  return {
    enginesDefaultHarnessId: partial?.enginesDefaultHarnessId ?? ENGINES_SETTINGS_DEFAULTS.enginesDefaultHarnessId,
    enginesClaudeCodeWarnOnOpenCodeHandoff:
      partial?.enginesClaudeCodeWarnOnOpenCodeHandoff
      ?? ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeWarnOnOpenCodeHandoff,
    enginesClaudeCodeEnabled:
      partial?.enginesClaudeCodeEnabled ?? ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeEnabled,
  };
}
