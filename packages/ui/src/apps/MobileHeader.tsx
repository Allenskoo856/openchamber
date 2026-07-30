import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
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
  /** iPad only: Files/Changes header shortcuts that toggle the right sidebar. */
  surfaceShortcuts?: MobileHeaderSurfaceShortcuts;
}> = ({ onOpenSessions, onOpenMenu, surfaceShortcuts }) => {
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
  const secondaryLabel = currentSessionId ? projectLabel : '';

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
            <Icon name="folders" className="size-5" />
          </button>

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            gitDirectory={gitDirectory}
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
        </div>
      </header>
    </>
  );
};
