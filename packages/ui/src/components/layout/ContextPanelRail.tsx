import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import {
  sortContextSurfaces,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  isAvailable: boolean;
  badgeCount: number | null;
  label: string;
  hint: string | null;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
};

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  isAvailable,
  badgeCount,
  label,
  hint,
  onSelect,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
    disabled: !isAvailable && !isActive,
  });

  const title = isAvailable ? label : (hint ?? label);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => {
          if (isAvailable) {
            onSelect(surface);
          }
        }}
        disabled={!isAvailable}
        title={title}
        aria-label={title}
        aria-pressed={isActive}
        className={cn(
          'flex h-9 w-9 touch-none select-none items-center justify-center rounded-md transition-colors',
          isActive
            ? 'bg-interactive-selection text-interactive-selection-foreground'
            : isAvailable
              ? 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
              : 'cursor-default text-muted-foreground/40',
        )}
      >
        <Icon name={surface.icon} className="h-4 w-4" />
        {badgeCount !== null && badgeCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--surface-elevated)] px-0.5 typography-micro leading-none text-muted-foreground"
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : null}
      </button>
    </div>
  );
};

export const ContextPanelRail: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setContextRailOrder = useUIStore((state) => state.setContextRailOrder);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const gitStatus = useGitStatus(directoryKey || null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const surfaces = React.useMemo(() => {
    const ordered = sortContextSurfaces(contextRailOrder);
    return planModeEnabled ? ordered : ordered.filter((surface) => surface.id !== 'plan');
  }, [contextRailOrder, planModeEnabled]);

  const tabs = panelState?.tabs ?? [];
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;
  const activeMode = panelState?.isOpen ? activeTab?.mode ?? null : null;
  const changedFilesCount = gitStatus?.files.length ?? 0;

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const orderedIds = sortContextSurfaces(useUIStore.getState().contextRailOrder).map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [setContextRailOrder]);

  if (!directoryKey) {
    return null;
  }

  return (
    <nav
      aria-label={t('contextRail.aria.rail')}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-1 border-l border-border/40 bg-background py-2"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={surfaces.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {surfaces.map((surface) => {
            const hasContent = tabs.some((tab) => tab.mode === surface.mode);
            const isAvailable = surface.availability === 'always' || hasContent;
            return (
              <ContextPanelRailItem
                key={surface.id}
                surface={surface}
                isActive={activeMode === surface.mode}
                isAvailable={isAvailable}
                badgeCount={surface.id === 'git' ? changedFilesCount : null}
                label={t(surface.labelKey)}
                hint={surface.unavailableHintKey ? t(surface.unavailableHintKey) : null}
                onSelect={(selected) => openContextSurface(directoryKey, selected.mode)}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </nav>
  );
};
