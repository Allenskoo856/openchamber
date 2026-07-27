import React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import type { SessionGroup } from './types';
import { SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';
import { useI18n } from '@/lib/i18n';
import type { MainTab } from '@/stores/useUIStore';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';

type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
    icon?: string;
    color?: string;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    iconBackground?: string;
  };
  groups: SessionGroup[];
};

type Props = {
  topContent?: React.ReactNode;
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  renderGroupSessions: (
    group: SessionGroup,
    groupKey: string,
    projectId?: string | null,
    hideGroupLabel?: boolean,
    compactBodyPadding?: boolean,
    scrollContainerRef?: React.RefObject<HTMLElement | null>,
  ) => React.ReactNode;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  isDesktopShellRuntime: boolean;
  stuckProjectHeaders: Set<string>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  projectSortOrder: ProjectSortOrder;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
};

function SidebarProjectsListComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const projectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);

  if (props.sharedSessionsOnly) {
    return (
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pr-2', props.mobileVariant ? '' : '')}>
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
      </ScrollableOverlay>
    );
  }

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <ScrollableOverlay ref={scrollContainerRef} useScrollShadow hideTopScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1.5 pb-1 pl-2.5 pr-2 [overflow-anchor:none]', props.mobileVariant ? '' : '')}>
      {props.topContent}
      {props.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem] py-1">
          {(() => {
            const activeSection = props.sectionsForRender.find((section) => section.project.id === props.activeProjectId) ?? props.sectionsForRender[0];
            if (!activeSection) {
              return props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState;
            }
            const primaryGroup =
              activeSection.groups.find((candidate) => candidate.isMain && candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.isMain)
              ?? activeSection.groups[0];
            if (!primaryGroup) {
              return <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessions.sidebar.empty.noSessions.title')}</div>;
            }
            const archivedGroup = activeSection.groups.find((candidate) => candidate.isArchivedBucket);
            const groupsToRender = [
              primaryGroup,
              ...(archivedGroup && archivedGroup.id !== primaryGroup.id ? [archivedGroup] : []),
            ];

            return groupsToRender.map((group) => {
              const groupKey = `${activeSection.project.id}:${group.id}`;
              const hideGroupLabel = group.id === primaryGroup.id;
              return (
                <React.Fragment key={groupKey}>
                  {props.renderGroupSessions(group, groupKey, activeSection.project.id, hideGroupLabel, true, scrollContainerRef)}
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : (
        <DndContext
          sensors={projectSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            if (props.isInlineEditing) return;
            // Drag only allowed in manual sort mode - indices from visual order don't match store order in other modes
            if (props.projectSortOrder !== 'manual') return;
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIndex = props.sectionsForRender.findIndex((section) => section.project.id === active.id);
            const newIndex = props.sectionsForRender.findIndex((section) => section.project.id === over.id);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
            props.reorderProjects(oldIndex, newIndex);
          }}
        >
          <SortableContext items={props.sectionsForRender.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
            {props.sectionsForRender.map((section) => {
              const project = section.project;
              const projectKey = project.id;
              const projectLabel = formatProjectLabel(
                project.label?.trim()
                || formatDirectoryName(project.normalizedPath, props.homeDirectory)
                || project.normalizedPath,
              );
              const projectDescription = formatPathForDisplay(project.normalizedPath, props.homeDirectory);
              const isCollapsed = props.collapsedProjects.has(projectKey);
              const isActiveProject = projectKey === props.activeProjectId;
              const isRepo = props.projectRepoStatus.get(projectKey);

              return (
                <SortableProjectItem
                  key={projectKey}
                  id={projectKey}
                  disabled={props.projectSortOrder !== 'manual'}
                  projectLabel={projectLabel}
                  projectDescription={projectDescription}
                  projectIcon={project.icon}
                  projectColor={project.color}
                  projectIconImage={project.iconImage}
                  projectIconBackground={project.iconBackground}
                  isCollapsed={isCollapsed}
                  isActiveProject={isActiveProject}
                  isRepo={Boolean(isRepo)}
                  isDesktopShell={props.isDesktopShellRuntime}
                  isStuck={props.stuckProjectHeaders.has(projectKey)}
                  hideDirectoryControls={props.hideDirectoryControls}
                  mobileVariant={props.mobileVariant}
                  alwaysShowActions={props.alwaysShowActions}
                  statusIndicator={isCollapsed ? props.renderProjectStatusIndicator?.(projectKey, section.groups) : null}
                  onToggle={() => props.toggleProject(projectKey)}
                  onNewSession={() => {
                    if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                    props.setActiveMainTab('chat');
                    if (props.mobileVariant) props.setSessionSwitcherOpen(false);
                    props.openNewSessionDraft({
                      selectedProjectId: projectKey,
                      directoryOverride: project.normalizedPath,
                    });
                  }}
                  onNewWorktreeSession={() => {
                    if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                    props.setActiveMainTab('chat');
                    props.openNewWorktreeDialog();
                  }}
                  onManageWorktrees={() => props.openWorktreesPage(projectKey)}
                  onRenameStart={() => props.openProjectEditDialog(projectKey)}
                  onClose={() => props.removeProject(projectKey)}
                  sentinelRef={(el) => { props.projectHeaderSentinelRefs.current.set(projectKey, el); }}
                  showCreateButtons
                  openSidebarMenuKey={props.openSidebarMenuKey}
                  setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                >
                  {!isCollapsed ? (
                    <div className="space-y-0 pt-0.5 pb-0.5">
                      {section.groups.map((group) => {
                        const groupKey = `${projectKey}:${group.id}`;
                        // Root/flat sessions render directly under the project
                        // zone header; worktree and archived groups keep their
                        // own slim sub-header.
                        return (
                          <React.Fragment key={groupKey}>
                            {props.renderGroupSessions(group, groupKey, projectKey, group.isMain, undefined, scrollContainerRef)}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  ) : null}
                </SortableProjectItem>
              );
            })}
          </SortableContext>
          <DragOverlay dropAnimation={null} />
        </DndContext>
      )}
    </ScrollableOverlay>
  );
}

export const SidebarProjectsList = React.memo(SidebarProjectsListComponent);
