import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

type Props = {
  onNewSession: () => void;
};

// Primary sidebar CTA: starting a session is the one action worth a full
// button; every other control lives in the quiet toolbar row below.
export function SidebarNav(props: Props): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="select-none flex-shrink-0 px-2.5 pt-1.5">
      <Button
        variant="secondary"
        size="sm"
        className="w-full justify-center gap-2"
        onClick={props.onNewSession}
      >
        <Icon name="chat-new" className="h-4 w-4" />
        {t('sessions.sidebar.header.actions.newSession')}
      </Button>
    </div>
  );
}
