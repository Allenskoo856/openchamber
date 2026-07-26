/** Tool names that render as shell/bash command surfaces across the chat UI. */
const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'cmd',
  'terminal',
  'shell_command',
]);

export const isShellToolName = (tool: string | null | undefined): boolean => {
  if (typeof tool !== 'string') return false;
  return SHELL_TOOL_NAMES.has(tool.trim().toLowerCase());
};
