import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { formatProjectLabel, formatSessionDateLabel, normalizePath } from '@/components/session/sidebar/utils';
import { useShallow } from 'zustand/react/shallow';

type ProjectBucket = {
  key: string;
  label: string;
  sessions: Session[];
};

const OTHER_BUCKET_KEY = '__other__';

export function ArchiveView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isArchivePageOpen);
  const setOpen = useUIStore((state) => state.setArchivePageOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const archivedSessions = useGlobalSessionsStore(useShallow((state) => open ? state.archivedSessions : []));
  const [query, setQuery] = React.useState('');

  const normalizedQuery = query.trim().toLowerCase();

  const buckets = React.useMemo<ProjectBucket[]>(() => {
    if (!open) return [];
    const normalizedProjects = projects
      .map((project) => ({
        id: project.id,
        label: formatProjectLabel(
          project.label?.trim()
          || formatDirectoryName(normalizePath(project.path) ?? project.path, homeDirectory)
          || project.path,
        ),
        normalizedPath: normalizePath(project.path)?.toLowerCase() ?? null,
      }))
      .filter((project) => Boolean(project.normalizedPath));

    const byKey = new Map<string, ProjectBucket>();
    const orderedKeys: string[] = [];
    const pushSession = (key: string, label: string, session: Session) => {
      const existing = byKey.get(key);
      if (existing) {
        existing.sessions.push(session);
        return;
      }
      byKey.set(key, { key, label, sessions: [session] });
      orderedKeys.push(key);
    };

    const sorted = [...archivedSessions].sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0));
    for (const session of sorted) {
      if (normalizedQuery) {
        const title = (session.title ?? '').toLowerCase();
        if (!title.includes(normalizedQuery)) continue;
      }
      const directory = normalizePath(resolveGlobalSessionDirectory(session))?.toLowerCase() ?? null;
      // Longest-prefix match so worktree sessions land in their parent project.
      let matched: { id: string; label: string } | null = null;
      let matchedLength = -1;
      if (directory) {
        for (const project of normalizedProjects) {
          const path = project.normalizedPath as string;
          if ((directory === path || directory.startsWith(`${path}/`)) && path.length > matchedLength) {
            matched = project;
            matchedLength = path.length;
          }
        }
        if (!matched) {
          // Worktrees usually live outside the project root; fall back to
          // matching the project whose name appears in the directory path.
          for (const project of normalizedProjects) {
            const name = (project.normalizedPath as string).split('/').pop();
            if (name && directory.includes(`/${name.toLowerCase()}`) && name.length > matchedLength) {
              matched = project;
              matchedLength = name.length;
            }
          }
        }
      }
      if (matched) {
        pushSession(matched.id, matched.label, session);
      } else {
        pushSession(OTHER_BUCKET_KEY, t('sessions.archivePage.otherProjects'), session);
      }
    }

    return orderedKeys
      .map((key) => byKey.get(key))
      .filter((bucket): bucket is ProjectBucket => Boolean(bucket));
  }, [archivedSessions, homeDirectory, normalizedQuery, open, projects, t]);

  const totalCount = archivedSessions.length;

  const openSession = React.useCallback((session: Session) => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    setCurrentSession(session.id, directory ?? undefined);
    setActiveMainTab('chat');
    setOpen(false);
  }, [setActiveMainTab, setCurrentSession, setOpen]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      {/* The app Header shows the surface title; keep only count + close. */}
      <div className="flex items-center justify-between gap-3 px-4 pt-2">
        <span className="typography-micro text-muted-foreground">
          {totalCount === 1
            ? t('sessions.archivePage.countSingle', { count: totalCount })
            : t('sessions.archivePage.countPlural', { count: totalCount })}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label={t('sessions.archivePage.closeAria')}
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sessions.archivePage.searchPlaceholder')}
              className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            />
          </div>

          {buckets.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <p className="typography-ui-label font-semibold">
                {normalizedQuery ? t('sessions.archivePage.empty.noMatches') : t('sessions.archivePage.empty.noArchived')}
              </p>
            </div>
          ) : buckets.map((bucket) => (
            <div key={bucket.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2 rounded-md bg-interactive-hover/40 px-2 py-1">
                <span className="typography-ui-label font-semibold lowercase text-foreground">{bucket.label}</span>
                <div className="flex items-center gap-2">
                  <span className="typography-micro text-muted-foreground">{bucket.sessions.length}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => sessionEvents.requestDelete({ sessions: bucket.sessions, mode: 'session' })}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-label={t('sessions.archivePage.deleteProjectAria', { label: bucket.label })}
                      >
                        <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>{t('sessions.archivePage.deleteProject')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              {bucket.sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn('group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-interactive-hover/40')}
                  onClick={() => openSession(session)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openSession(session);
                    }
                  }}
                >
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                    {session.title || t('sessions.sidebar.session.untitled')}
                  </span>
                  <span className="flex-shrink-0 text-[0.72rem] text-muted-foreground/75">
                    {formatSessionDateLabel(session.time?.archived ?? session.time?.updated ?? session.time?.created ?? Date.now())}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      sessionEvents.requestDelete({ sessions: [session], mode: 'session' });
                    }}
                    className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-label={t('sessions.archivePage.deleteSessionAria', { title: session.title || t('sessions.sidebar.session.untitled') })}
                  >
                    <Icon name="delete-bin" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
