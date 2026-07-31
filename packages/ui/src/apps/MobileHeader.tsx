import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';

import { MobileSessionMetadataButton } from './MobileSessionMetadata';
import { getProjectDisplayLabel, normalizePath } from './mobilePaths';

export type MobileHeaderSurfaceShortcuts = {
  activePanel: 'files' | 'changes' | null;
  changesDirty: boolean;
  onToggleFiles: () => void;
  onToggleChanges: () => void;
};

export const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  onOpenMenu: () => void;
  /** Phone only: opens the right workspace drawer (Changes / Files / Terminal). */
  onOpenWorkspace?: () => void;
  /** Shows a dirty-changes dot on the workspace button. */
  workspaceDirty?: boolean;
  /** iPad only: Files/Changes header shortcuts that toggle the right sidebar. */
  surfaceShortcuts?: MobileHeaderSurfaceShortcuts;
}> = ({ onOpenSessions, onOpenMenu, onOpenWorkspace, workspaceDirty = false, surfaceShortcuts }) => {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const gitDirectory = normalizePath(effectiveDirectory) || null;
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const currentWorktreeMetadata = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.worktreeMetadata.get(currentSessionId) ?? null : null), [currentSessionId]),
  );
  const currentSession = useSession(currentSessionId, effectiveDirectory || undefined);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));

  // Branch lives in the header's metadata line (project · branch), both for an
  // open session and for the draft screen.
  const { git } = useRuntimeAPIs();
  const isGitRepo = useIsGitRepo(gitDirectory);
  const gitStatus = useGitStatus(gitDirectory);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);

  React.useEffect(() => {
    if (!gitDirectory) return;
    void ensureStatus(gitDirectory, git);
  }, [ensureStatus, git, gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== gitDirectory) return;
      void fetchStatus(gitDirectory, git);
    });
  }, [fetchStatus, git, gitDirectory]);

  // Only a real, resolved branch name — while git status is still loading (or
  // on a detached HEAD) show nothing rather than a scary placeholder.
  const branchLabel = isGitRepo === true ? (gitStatus?.current?.trim() || null) : null;

  const projectLabel = React.useMemo(() => {
    const directory = normalizePath(effectiveDirectory);
    if (!directory) return t('mobile.header.noProject');
    const metadataProject = currentWorktreeMetadata?.projectDirectory
      ? resolveProjectForDirectory(projects, currentWorktreeMetadata.projectDirectory)
      : null;
    const project = metadataProject ?? resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return getProjectDisplayLabel(project, directory) || t('mobile.header.noProject');
  }, [availableWorktreesByProject, currentWorktreeMetadata?.projectDirectory, effectiveDirectory, projects, t]);

  const sessionTitle = currentSession?.title?.trim();
  const primaryLabel = sessionTitle || (currentSessionId ? t('mobile.sessions.untitled') : projectLabel);
  // Open session: "project · branch" under the title. Draft: the project is
  // the title, so the metadata line is just the branch.
  const secondaryLabel = currentSessionId
    ? [projectLabel, branchLabel].filter(Boolean).join(' · ')
    : (branchLabel ?? '');

  React.useEffect(() => {
    setMetadataOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenSessions();
  }, [onOpenSessions]);

  const handleOpenMenu = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenMenu();
  }, [onOpenMenu]);

  return (
    <>
      <header
        className="oc-mobile-header relative z-30 flex shrink-0 items-center gap-1 border-b border-border/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <div className="flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2">
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="list-unordered" className="size-5" />
          </button>

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            isNewSessionDraftOpen={isNewSessionDraftOpen}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />

          {surfaceShortcuts ? (
            <>
              <button
                type="button"
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'files'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.files')}
                aria-pressed={surfaceShortcuts.activePanel === 'files'}
                onClick={surfaceShortcuts.onToggleFiles}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="file-text" className="size-5" />
              </button>
              <button
                type="button"
                className={cn(
                  'relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'changes'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.changes')}
                aria-pressed={surfaceShortcuts.activePanel === 'changes'}
                onClick={surfaceShortcuts.onToggleChanges}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="git-branch" className="size-5" />
                {surfaceShortcuts.changesDirty ? (
                  <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
                ) : null}
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.header.openMenuAria')}
            onClick={handleOpenMenu}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="more-2" className="size-5" />
          </button>

          {onOpenWorkspace ? (
            <button
              type="button"
              className="relative flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('mobile.header.openWorkspaceAria')}
              onClick={() => {
                setMetadataOpen(false);
                onOpenWorkspace();
              }}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="layout-right" className="size-5" />
              {workspaceDirty ? (
                <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
              ) : null}
            </button>
          ) : null}
        </div>
      </header>
    </>
  );
};
