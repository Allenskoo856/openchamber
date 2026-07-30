import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TerminalView } from '@/components/views/TerminalView';
import { useI18n } from '@/lib/i18n';

import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 200;

export type MobileWorkspaceTab = 'changes' | 'files' | 'terminal';

const TAB_ORDER: MobileWorkspaceTab[] = ['changes', 'files', 'terminal'];

const TAB_LABEL_KEYS = {
  changes: 'mobile.menu.changes',
  files: 'mobile.menu.files',
  terminal: 'mobile.menu.terminal',
} as const satisfies Record<MobileWorkspaceTab, string>;

/** Full-width right drawer with the phone workspace surfaces as tabs
    (Changes / Files / Terminal). Slides in from the right edge; closes via
    the header X, Escape (unless the terminal tab owns the keys), or the
    Android back button (handled by MobileShell). */
export const MobileWorkspaceDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  /** When set, the Changes tab opens directly into the per-file diff. */
  pendingChangesDiff: { path: string; staged: boolean } | null;
}> = ({ open, onClose, tab, onTabChange, pendingChangesDiff }) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const tabRef = React.useRef(tab);
  React.useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      // The terminal owns Escape (it goes to the PTY) — don't hijack it.
      if (event.key === 'Escape' && tabRef.current !== 'terminal') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!rootRef.current) return null;

  return createPortal(
    <section
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.header.openWorkspaceAria')}
      aria-hidden={!open}
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Settled state drops the transform entirely so the drawer isn't kept
        // on a compositing layer (iOS clips those to the safe-area viewport).
        transform: entered ? 'none' : 'translateX(100%)',
        transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {TAB_ORDER.map((entry) => (
            <Button
              key={entry}
              type="button"
              variant="chip"
              size="sm"
              aria-pressed={tab === entry}
              onClick={() => onTabChange(entry)}
              style={{ touchAction: 'manipulation' }}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </Button>
          ))}
        </div>
        <button
          type="button"
          className="-mr-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('mobile.surface.closeAria')}
          onClick={onClose}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Mounted only while shown (incl. the exit slide) so each surface
            computes its safe-area / fixed-position layout fresh on open. */}
        {visible ? (
          <ErrorBoundary>
            {tab === 'changes' ? (
              <MobileChangesSurface
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
              />
            ) : tab === 'files' ? (
              <MobileFilesSurface />
            ) : (
              <TerminalView visible={open} />
            )}
          </ErrorBoundary>
        ) : null}
      </div>
    </section>,
    rootRef.current,
  );
};
