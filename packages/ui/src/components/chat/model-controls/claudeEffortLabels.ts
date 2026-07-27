/** i18n keys for Claude reasoning-effort levels. */

import type { ClaudeEffort } from '@/lib/harness/claude-models';

export const CLAUDE_EFFORT_LABEL_KEYS: Record<
    ClaudeEffort,
    | 'chat.engines.effort.low'
    | 'chat.engines.effort.medium'
    | 'chat.engines.effort.high'
    | 'chat.engines.effort.xhigh'
    | 'chat.engines.effort.max'
> = {
    low: 'chat.engines.effort.low',
    medium: 'chat.engines.effort.medium',
    high: 'chat.engines.effort.high',
    xhigh: 'chat.engines.effort.xhigh',
    max: 'chat.engines.effort.max',
};
