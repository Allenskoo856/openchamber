export const OPENCHAMBER_CONTROL_ACTION_DEFINITIONS = Object.freeze([
  { action: 'projects.list', title: 'List configured projects', description: 'List configured projects; no parameters' },
  { action: 'models.list', title: 'Show model preferences', description: 'Show default, favorite, and recent model preferences; no parameters' },
  { action: 'session.list', title: 'List sessions', description: 'List sessions; optional directory, limit (default 10), all, or withStatus' },
  { action: 'session.create', title: 'Create a session', description: 'Create a session; prompt and new worktree are optional' },
  { action: 'session.send', title: 'Send a prompt', description: 'Send prompt to sessionId; scope with projectId or directory' },
  { action: 'session.fork', title: 'Fork a session', description: 'Fork sessionId; messageId selects the boundary; prompt is optional' },
  { action: 'session.status', title: 'Check session status', description: 'Check sessionId status; directory defaults to the current session' },
  { action: 'session.messages', title: 'Read session messages', description: 'Read text-only messages for sessionId; directory and limit 10 are defaults' },
  { action: 'schedule.status', title: 'Check scheduler status', description: 'Check scheduler status; no parameters' },
  { action: 'schedule.list', title: 'List scheduled tasks', description: 'List tasks; scope with projectId or directory' },
  { action: 'schedule.create', title: 'Create a scheduled task', description: 'Create task; requires name, prompt, model, and one schedule selector' },
  { action: 'schedule.run', title: 'Run a scheduled task', description: 'Run taskId; scope with projectId or directory' },
  { action: 'schedule.delete', title: 'Delete a scheduled task', description: 'Delete taskId; scope with projectId or directory' },
  { action: 'schedule.enable', title: 'Enable a scheduled task', description: 'Enable taskId; scope with projectId or directory' },
  { action: 'schedule.disable', title: 'Disable a scheduled task', description: 'Disable taskId; scope with projectId or directory' },
]);

export const OPENCHAMBER_CONTROL_ACTIONS = Object.freeze(
  OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENCHAMBER_CONTROL_ACTION_TITLES = Object.freeze(
  Object.fromEntries(OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.map(({ action, title }) => [action, title])),
);
