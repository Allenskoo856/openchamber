import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type Props = {
  onNewSession: () => void;
  onOpenScheduled: () => void;
  onOpenMultiRun: () => void;
  canOpenMultiRun: boolean;
  onOpenArchive: () => void;
};

const navItemClass =
  'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50';
const navIconClass = 'h-4 w-4 flex-shrink-0 text-muted-foreground';

// Top-level navigation列 above the session tree: primary actions and
// full-page surfaces (Scheduled, Multi-run, Archive) as text rows.
export function SidebarNav(props: Props): React.ReactNode {
  const { t } = useI18n();
  return (
    <nav className="flex-shrink-0 select-none space-y-0.5 px-2.5 pb-2">
      <button type="button" className={navItemClass} onClick={props.onNewSession}>
        <Icon name="chat-new" className={navIconClass} />
        <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
      </button>
      <button type="button" className={navItemClass} onClick={props.onOpenScheduled}>
        <Icon name="calendar-schedule" className={navIconClass} />
        <span className="truncate">{t('sessions.sidebar.header.actions.scheduledTasks')}</span>
      </button>
      <button
        type="button"
        className={navItemClass}
        onClick={props.onOpenMultiRun}
        disabled={!props.canOpenMultiRun}
      >
        <ArrowsMerge className={cn(navIconClass)} />
        <span className="truncate">{t('sessions.sidebar.header.actions.newMultiRun')}</span>
      </button>
      <button type="button" className={navItemClass} onClick={props.onOpenArchive}>
        <Icon name="archive" className={navIconClass} />
        <span className="truncate">{t('sessions.sidebar.nav.archive')}</span>
      </button>
    </nav>
  );
}
