import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

type Props = {
  onNewSession: () => void;
  onOpenScheduled: () => void;
  onOpenMultiRun: () => void;
  canOpenMultiRun: boolean;
  onOpenArchive: () => void;
};

const navIconButtonClass =
  'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50';

// Session-level controls in one row: "New session" as the primary text
// action, with the page surfaces (Scheduled, Multi-run, Archive) as icons at
// the right — mirroring the "Add project + project controls" row below it.
export function SidebarNav(props: Props): React.ReactNode {
  const { t } = useI18n();
  return (
    <nav className="select-none flex-shrink-0 px-2.5 pt-1">
      <div className="flex h-8 items-center justify-between gap-2">
        <button
          type="button"
          onClick={props.onNewSession}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name="chat-new" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
        </button>

        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={props.onOpenScheduled}
                className={navIconButtonClass}
                aria-label={t('sessions.sidebar.header.actions.scheduledTasks')}
              >
                <Icon name="calendar-schedule" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.scheduledTasks')}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={props.onOpenMultiRun}
                className={navIconButtonClass}
                aria-label={t('sessions.sidebar.header.actions.newMultiRun')}
                disabled={!props.canOpenMultiRun}
              >
                <ArrowsMerge className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newMultiRun')}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={props.onOpenArchive}
                className={navIconButtonClass}
                aria-label={t('sessions.sidebar.nav.archive')}
              >
                <Icon name="archive" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.nav.archive')}</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}
