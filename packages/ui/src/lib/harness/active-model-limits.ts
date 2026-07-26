/**
 * Resolve context/output limits for the active composer/session target.
 * When Claude Code is selected, OpenCode getCurrentModel() limits must not be used.
 */

import type { EngineCatalog, ExecutionTarget } from '@/types/harness';
import { isExecutionTarget } from '@/types/harness';
import {
  buildClaudeModelMetadata,
  resolveClaudeCatalogModel,
} from '@/lib/harness/claude-models';

export type ActiveModelLimits = {
  context: number;
  output: number;
  modelName: string;
  source: 'claude-code' | 'opencode';
};

function resolveActiveTarget(args: {
  sessionId?: string | null;
  sessionTarget?: ExecutionTarget | null;
  pendingHandoffTarget?: ExecutionTarget | null;
  lastUsedTarget?: ExecutionTarget | null;
}): ExecutionTarget | null {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (sessionId) {
    if (args.sessionTarget && isExecutionTarget(args.sessionTarget)) return args.sessionTarget;
    if (args.pendingHandoffTarget && isExecutionTarget(args.pendingHandoffTarget)) {
      return args.pendingHandoffTarget;
    }
  }
  if (args.lastUsedTarget && isExecutionTarget(args.lastUsedTarget)) {
    return args.lastUsedTarget;
  }
  return null;
}

export function resolveActiveModelLimits(args: {
  sessionId?: string | null;
  sessionTarget?: ExecutionTarget | null;
  pendingHandoffTarget?: ExecutionTarget | null;
  lastUsedTarget?: ExecutionTarget | null;
  claudeCatalog?: EngineCatalog | null;
  /** OpenCode live/current model limits when engine is OpenCode. */
  openCodeContext?: number | null;
  openCodeOutput?: number | null;
  openCodeModelName?: string | null;
}): ActiveModelLimits {
  const target = resolveActiveTarget(args);

  if (target?.harnessId === 'claude-code') {
    const modelRef = typeof target.modelRef === 'string' && target.modelRef.trim()
      ? target.modelRef.trim()
      : 'sonnet';
    const models = args.claudeCatalog?.sections.flatMap((section) => section.models) ?? [];
    const metadata = buildClaudeModelMetadata(resolveClaudeCatalogModel(models, modelRef));
    return {
      context: metadata.limit?.context ?? 200_000,
      output: metadata.limit?.output ?? 64_000,
      modelName: metadata.name ?? modelRef,
      source: 'claude-code',
    };
  }

  return {
    context: typeof args.openCodeContext === 'number' && Number.isFinite(args.openCodeContext)
      ? args.openCodeContext
      : 0,
    output: typeof args.openCodeOutput === 'number' && Number.isFinite(args.openCodeOutput)
      ? args.openCodeOutput
      : 0,
    modelName: typeof args.openCodeModelName === 'string' ? args.openCodeModelName : '',
    source: 'opencode',
  };
}
