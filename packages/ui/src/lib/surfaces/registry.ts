import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { ContextPanelMode } from '@/stores/useUIStore';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'diff'
  | 'plan'
  | 'notes'
  | 'context'
  | 'browser'
  | 'preview'
  | 'chat';

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  labelKey: I18nKey;
  /**
   * 'always' surfaces can be opened empty from the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a file opened, a preview URL emitted, a split session) and
   * render disabled on the rail until one exists.
   */
  availability: 'always' | 'has-content';
  /** Hint shown while a 'has-content' surface has no content yet. */
  unavailableHintKey?: I18nKey;
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'editor',
    mode: 'file',
    icon: 'file-code',
    labelKey: 'contextPanel.mode.files',
    availability: 'has-content',
    unavailableHintKey: 'contextRail.hint.editorUnavailable',
  },
  {
    id: 'git',
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'diff',
    mode: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'plan',
    mode: 'plan',
    icon: 'file-text',
    labelKey: 'contextPanel.mode.plan',
    availability: 'always',
  },
  {
    id: 'notes',
    mode: 'notes',
    icon: 'sticky-note',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'context',
    mode: 'context',
    icon: 'donut-chart-fill',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'browser',
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'preview',
    mode: 'preview',
    icon: 'window',
    labelKey: 'contextPanel.mode.preview',
    availability: 'has-content',
    unavailableHintKey: 'contextRail.hint.previewUnavailable',
  },
  {
    id: 'chat',
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
    unavailableHintKey: 'contextRail.hint.chatUnavailable',
  },
];

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface]));

const isContextSurfaceId = (value: unknown): value is ContextSurfaceId => {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (railOrder: readonly string[]): ContextSurfaceDescriptor[] => {
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<ContextSurfaceId>();

  for (const id of railOrder) {
    if (!isContextSurfaceId(id) || seen.has(id)) {
      continue;
    }
    const surface = SURFACE_BY_ID.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of CONTEXT_SURFACES) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};
