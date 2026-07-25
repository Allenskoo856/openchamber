export type {
  QuotaProviderId,
  UsageWindow,
  UsageWindows,
  ProviderResult
} from './quota';

export type {
  HarnessId,
  ExecutionTarget,
  ClaudePermissionMode,
  CapabilityLevel,
  HarnessCapability,
  HarnessRuntimeStatus,
  HarnessAuthMode,
  HarnessDescriptor,
  EngineCatalog,
  EngineCatalogModel,
  EngineCatalogSection,
} from './harness';

export {
  HARNESS_IDS,
  HARNESS_CAPABILITIES,
  isHarnessId,
  isHarnessRuntimeStatus,
  isCapabilityLevel,
  isClaudePermissionMode,
  isExecutionTarget,
} from './harness';

export interface ModelMetadata {
  id: string;
  providerId: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
}
