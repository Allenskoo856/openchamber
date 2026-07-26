import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { formatProjectLabel, normalizePath } from '@/components/session/sidebar/utils';

// Full-page worktree management surface for a single project, opened from the
// project menu in the sidebar. Wraps the shared WorktreeSectionContent that
// also powers the project settings panel.
export function WorktreesView(): React.ReactNode {
  const { t } = useI18n();
  const projectId = useUIStore((state) => state.worktreesPageProjectId);
  const setWorktreesPageProjectId = useUIStore((state) => state.setWorktreesPageProjectId);
  const setNewWorktreeDialogOpen = useUIStore((state) => state.setNewWorktreeDialogOpen);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === projectId) ?? null);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  if (!projectId || !project) return null;

  const projectLabel = formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(normalizePath(project.path) ?? project.path, homeDirectory)
    || project.path,
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div className="min-w-0">
          <h2 className="typography-ui-label font-semibold text-foreground">
            {t('sessions.worktreesPage.title', { project: projectLabel })}
          </h2>
          <p className="typography-micro text-muted-foreground">{t('sessions.worktreesPage.description')}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setActiveProjectIdOnly(project.id);
              setNewWorktreeDialogOpen(true);
            }}
          >
            <Icon name="node-tree" className="mr-1 h-3.5 w-3.5" />
            {t('sessions.sidebar.project.actions.newWorktree')}
          </Button>
          <button
            type="button"
            onClick={() => setWorktreesPageProjectId(null)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label={t('sessions.worktreesPage.closeAria')}
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-2xl">
          <WorktreeSectionContent projectRef={{ id: project.id, path: project.path }} />
        </div>
      </div>
    </div>
  );
}
