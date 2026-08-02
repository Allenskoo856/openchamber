import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import type { WalkthroughStage } from '@/lib/walkthrough/types';
import { cn } from '@/lib/utils';

interface WalkthroughStagesProps {
  stage: WalkthroughStage | null;
}

/**
 * The wait is long and uneven — collecting a pull request diff is seconds of
 * network, the model call is minutes — and a lone spinner makes those look
 * identical. Naming the phase at least says which one you are waiting on, and
 * that the cost has been committed once it reads "asking".
 *
 * No durations: a stopwatch on a step nobody can hurry adds pressure, not
 * information.
 */
const STAGES: Array<{ stage: WalkthroughStage; labelKey: I18nKey }> = [
  { stage: 'collecting', labelKey: 'walkthrough.stage.collecting' },
  { stage: 'asking', labelKey: 'walkthrough.stage.asking' },
  { stage: 'assembling', labelKey: 'walkthrough.stage.assembling' },
];

const RETRY_INDEX = 1;

export const WalkthroughStages = ({ stage }: WalkthroughStagesProps) => {
  const { t } = useI18n();

  // `retrying` is a second attempt at the model step rather than a step of its
  // own, so it renders in place: showing it as a fourth row would suggest the
  // work moved forward when it actually went back.
  const isRetrying = stage === 'retrying';
  const activeIndex = isRetrying
    ? RETRY_INDEX
    : STAGES.findIndex((entry) => entry.stage === stage);

  return (
    <ul className="flex flex-col gap-2 text-left">
      {STAGES.map((entry, index) => {
        const isDone = activeIndex > index;
        const isActive = activeIndex === index;

        return (
          <li key={entry.stage} className="flex items-center gap-2">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {isDone ? (
                <Icon name="check" className="size-3.5 text-status-success" />
              ) : isActive ? (
                <Icon name="loader-4" className="size-3.5 animate-spin text-[var(--status-info)]" />
              ) : (
                <span className="size-1.5 rounded-full bg-surface-muted" />
              )}
            </span>
            <span
              className={cn(
                'typography-meta',
                isActive ? 'text-foreground' : isDone ? 'text-muted-foreground' : 'text-muted-foreground/60'
              )}
            >
              {isActive && isRetrying ? t('walkthrough.stage.retrying') : t(entry.labelKey)}
            </span>
          </li>
        );
      })}
    </ul>
  );
};
