/**
 * Resolve which model metadata the composer should use for attachment
 * modality warnings. Must follow the active ExecutionTarget (Claude vs OpenCode),
 * not only OpenCode config-store currentProvider/currentModel.
 */

import type { ModelMetadata } from '@/types';
import type { EngineCatalog, ExecutionTarget } from '@/types/harness';
import { isExecutionTarget } from '@/types/harness';
import {
  buildClaudeModelMetadata,
  resolveClaudeCatalogModel,
} from '@/lib/harness/claude-models';

export type ComposerAttachmentModel = {
  modelKey: string;
  modelName: string;
  inputModalities: string[] | undefined;
};

function resolveActiveComposerTarget(args: {
  sessionId?: string | null;
  sessionTarget?: ExecutionTarget | null;
  pendingHandoffTarget?: ExecutionTarget | null;
  lastUsedTarget?: ExecutionTarget | null;
}): ExecutionTarget | null {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (sessionId) {
    if (args.sessionTarget && isExecutionTarget(args.sessionTarget)) {
      return args.sessionTarget;
    }
    if (args.pendingHandoffTarget && isExecutionTarget(args.pendingHandoffTarget)) {
      return args.pendingHandoffTarget;
    }
  }
  if (args.lastUsedTarget && isExecutionTarget(args.lastUsedTarget)) {
    return args.lastUsedTarget;
  }
  return null;
}

export function resolveComposerAttachmentModel(args: {
  sessionId?: string | null;
  sessionTarget?: ExecutionTarget | null;
  pendingHandoffTarget?: ExecutionTarget | null;
  lastUsedTarget?: ExecutionTarget | null;
  openCodeProviderId?: string | null;
  openCodeModelId?: string | null;
  openCodeMetadata?: ModelMetadata | null;
  claudeCatalog?: EngineCatalog | null;
}): ComposerAttachmentModel {
  const target = resolveActiveComposerTarget(args);

  if (target?.harnessId === 'claude-code') {
    const modelRef = typeof target.modelRef === 'string' && target.modelRef.trim()
      ? target.modelRef.trim()
      : 'sonnet';
    const models = args.claudeCatalog?.sections.flatMap((section) => section.models) ?? [];
    const metadata = buildClaudeModelMetadata(resolveClaudeCatalogModel(models, modelRef));
    return {
      modelKey: `claude-code/${modelRef}`,
      modelName: metadata.name ?? modelRef,
      inputModalities: metadata.modalities?.input,
    };
  }

  const providerId = typeof args.openCodeProviderId === 'string' ? args.openCodeProviderId : '';
  const modelId = typeof args.openCodeModelId === 'string' ? args.openCodeModelId : '';
  const metadata = args.openCodeMetadata ?? undefined;
  return {
    modelKey: `${providerId}/${modelId}`,
    modelName: metadata?.name ?? modelId,
    inputModalities: metadata?.modalities?.input,
  };
}
