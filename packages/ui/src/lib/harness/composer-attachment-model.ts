/**
 * Resolve which model metadata the composer should use for attachment
 * modality warnings. Must follow the active ExecutionTarget (Claude vs OpenCode),
 * not only OpenCode config-store currentProvider/currentModel.
 */

import type { ModelMetadata } from '@/types';
import type { EngineCatalog } from '@/types/harness';
import { resolveActiveClaudeModel } from '@/lib/harness/claude-models';
import {
  resolveActiveEngineTarget,
  type ActiveEngineTargetArgs,
} from '@/lib/harness/resolve-execution-target';

export type ComposerAttachmentModel = {
  modelKey: string;
  modelName: string;
  inputModalities: string[] | undefined;
};

export function resolveComposerAttachmentModel(args: ActiveEngineTargetArgs & {
  openCodeProviderId?: string | null;
  openCodeModelId?: string | null;
  openCodeMetadata?: ModelMetadata | null;
  claudeCatalog?: EngineCatalog | null;
}): ComposerAttachmentModel {
  const target = resolveActiveEngineTarget(args);

  if (target?.harnessId === 'claude-code') {
    const { modelRef, metadata } = resolveActiveClaudeModel(target, args.claudeCatalog);
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
