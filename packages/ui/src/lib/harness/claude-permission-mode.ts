import type { ClaudePermissionMode } from '@/types/harness';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';

/**
 * Map OpenCode agent edit permission → Claude Agent SDK permissionMode.
 * Claude modes are coarser than per-tool OpenCode rules; edit is the closest
 * shared control surface (composer agent chip / agent settings).
 */
export function claudePermissionModeFromEditPermission(
  editPermission: EditPermissionMode | undefined,
): ClaudePermissionMode {
  if (editPermission === 'allow') return 'acceptEdits';
  if (editPermission === 'deny') return 'plan';
  return 'default';
}
