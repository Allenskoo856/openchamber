/**
 * Reproduction for issue #2562 — "[Bug] Wrong context window usage graph when loading old session"
 *
 * Symptom: reopening a session from yesterday showed 115% context window usage,
 * while the same session showed ~30% after restarting VS Code.
 *
 * The displayed value is computed by the VS Code header (`VSCodeLayout.tsx`
 * `VSCodeHeader`, lines ~688-749, same logic as `MiniChatLayout.tsx` lines ~137-195):
 *
 *   const modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel;
 *   const limit = ...;
 *   const contextLimit = limit && typeof limit.context === 'number' ? limit.context : 0;
 *   ...
 *   const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning
 *     + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0);
 *   const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0;
 *
 * Root cause: the limit used for the percentage is the *current config model's*
 * limit (`currentModel?.limit ? currentModel : ...`). When an old session is
 * re-opened, the config's current model can still be a stale/different model
 * (the session's own model is restored asynchronously by ModelControls after
 * hydration). The session's actual model (`latestAssistantModel`, resolved from
 * the last assistant message's providerID/modelID) is only used as a fallback.
 *
 * This test reproduces the exact computation with the data from the report:
 * DeepSeek V4 Pro (1M context limit) session, last assistant message carrying
 * ~295K tokens. First open resolves the limit from a stale current model
 * (256K context) -> 115%. After the session model is restored, the limit is the
 * session model's 1M -> 30%.
 */
import { describe, expect, test } from 'bun:test';

type AssistantTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache?: { read?: number; write?: number };
};

type ProviderModelLike = {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
};

type ProviderLike = {
  id?: string;
  models?: ProviderModelLike[];
};

type SessionMessageLike = {
  id?: string;
  role?: string;
  providerID?: string;
  modelID?: string;
  tokens?: AssistantTokens;
};

/** Mirrors `VSCodeHeader` in `VSCodeLayout.tsx` (lines ~688-749). */
const computeHeaderContextUsage = ({
  currentModel,
  providers,
  messages,
}: {
  currentModel: ProviderModelLike | undefined;
  providers: ProviderLike[];
  messages: SessionMessageLike[];
}): { totalTokens: number; percentage: number; contextLimit: number; thresholdLimit: number } | null => {
  // headerMessageSummary memo: find latest assistant model + last message tokens
  let latestAssistantModel: ProviderModelLike | undefined;
  let lastTokens: AssistantTokens | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    if (!latestAssistantModel && typeof message.providerID === 'string' && typeof message.modelID === 'string') {
      const provider = providers.find((entry) => entry.id === message.providerID);
      latestAssistantModel = provider?.models?.find((entry) => entry.id === message.modelID);
    }
    if (!lastTokens && message.tokens) {
      const total = message.tokens.input + message.tokens.output + message.tokens.reasoning
        + (message.tokens.cache?.read ?? 0) + (message.tokens.cache?.write ?? 0);
      if (total > 0) {
        lastTokens = message.tokens;
      }
    }
    if (latestAssistantModel && lastTokens) break;
  }

  if (!lastTokens) return null;

  // modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel
  const modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel;
  const limit = modelForLimits && typeof modelForLimits.limit === 'object' && modelForLimits.limit !== null
    ? (modelForLimits.limit as Record<string, unknown>)
    : null;
  const contextLimit = limit && typeof limit.context === 'number' ? limit.context : 0;

  const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning
    + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0);
  const thresholdLimit = contextLimit > 0 ? contextLimit : 200000;
  const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0;

  return { totalTokens, percentage, contextLimit, thresholdLimit };
};

describe('issue #2562 — wrong context window usage graph when loading old session', () => {
  // DeepSeek V4 Pro on "Go" provider, 1M context window (per the report).
  const deepSeekV4Pro: ProviderModelLike = {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    limit: { context: 1_000_000, output: 32_000 },
  };
  // A smaller model that can be the stale/current config selection (256K context).
  const smallerModel: ProviderModelLike = {
    id: 'small-model',
    name: 'Small model',
    limit: { context: 256_000, output: 8_000 },
  };
  const providers: ProviderLike[] = [
    { id: 'go', models: [deepSeekV4Pro, smallerModel] },
  ];

  // The old session: last assistant message carries ~295K tokens and was produced
  // by DeepSeek V4 Pro (providerID/modelID recorded on the message).
  const oldSessionMessages: SessionMessageLike[] = [
    { id: 'm1', role: 'user', tokens: { input: 10_000, output: 0, reasoning: 0 } },
    { id: 'm2', role: 'assistant', providerID: 'go', modelID: 'deepseek-v4-pro', tokens: { input: 90_000, output: 4_000, reasoning: 6_000, cache: { read: 40_000, write: 5_000 } } },
    { id: 'm3', role: 'user', tokens: { input: 5_000, output: 0, reasoning: 0 } },
    {
      id: 'm4',
      role: 'assistant',
      providerID: 'go',
      modelID: 'deepseek-v4-pro',
      tokens: { input: 200_000, output: 5_000, reasoning: 10_000, cache: { read: 70_000, write: 10_000 } },
    },
  ];

  test('first open: stale current config model (256K) makes the graph show ~115%', () => {
    // On first open, the config's current model is still the stale selection
    // (the session's own model is restored asynchronously later).
    const usage = computeHeaderContextUsage({
      currentModel: smallerModel,
      providers,
      messages: oldSessionMessages,
    });

    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(295_000);
    expect(usage!.contextLimit).toBe(256_000);
    expect(usage!.percentage).toBe(115); // matches the 115% screenshot
  });

  test('after restart / model restore: session model (1M) makes the graph show ~30%', () => {
    // Once the session's saved model selection is applied, `getCurrentModel()`
    // returns DeepSeek V4 Pro with its 1M context limit.
    const usage = computeHeaderContextUsage({
      currentModel: deepSeekV4Pro,
      providers,
      messages: oldSessionMessages,
    });

    expect(usage).not.toBeNull();
    expect(usage!.contextLimit).toBe(1_000_000);
    expect(usage!.percentage).toBe(30); // matches the 30% after restart
  });

  test('the session model limit is only honored when the current model has no limit (root cause)', () => {
    // `modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel`:
    // the session's actual model is only a fallback.
    // With no current model limit, the session model's 1M limit is used -> 30%.
    const fallbackUsage = computeHeaderContextUsage({
      currentModel: undefined,
      providers,
      messages: oldSessionMessages,
    });
    expect(fallbackUsage!.contextLimit).toBe(1_000_000);
    expect(fallbackUsage!.percentage).toBe(30);

    // With a stale current model that has a limit, the session model is ignored.
    const overriddenUsage = computeHeaderContextUsage({
      currentModel: smallerModel,
      providers,
      messages: oldSessionMessages,
    });
    expect(overriddenUsage!.contextLimit).toBe(256_000);
    expect(overriddenUsage!.percentage).toBe(115);
  });
});
