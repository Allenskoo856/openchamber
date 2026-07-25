/**
 * TEMPORARY diagnostic — remove once the mobile pill↔composer swap timing is
 * resolved.
 *
 * The report: the visual swap between the collapsed pill and the full composer
 * appears to happen only once the keyboard has finished moving, where it used
 * to be instant. Two plausible fixes changed nothing, which means the theory
 * behind them was wrong — this overlay exists to replace theories with an
 * observed timeline.
 *
 * It draws the last events with millisecond offsets straight onto the screen,
 * so a screenshot after one expand/collapse answers, in order:
 *  - did the tap run the expand at all, and when;
 *  - when did React commit the swap, and when did the browser first paint
 *    after it (the two rAF entries);
 *  - when did the keyboard choreography start and settle;
 *  - whether the editor was created fresh or re-attached from the store.
 *
 * It also doubles as an asset-freshness check: if the overlay is not visible
 * at all, the app is running a bundle from before this commit.
 *
 * Capacitor-only; desktop and hosted mobile never see it.
 */

import { isCapacitorApp } from '@/lib/platform';

let overlay: HTMLDivElement | null = null;
let firstEventAt = 0;
const lines: string[] = [];

const MAX_LINES = 16;
/** A pause this long starts a fresh timeline: one gesture per screenshot. */
const RESET_AFTER_MS = 4000;

function enabled(): boolean {
    return typeof window !== 'undefined' && isCapacitorApp();
}

function ensureOverlay(): HTMLDivElement {
    if (overlay && overlay.isConnected) return overlay;
    const el = document.createElement('div');
    el.setAttribute('data-kb-timeline', 'true');
    el.style.cssText = [
        'position:fixed',
        'top:calc(env(safe-area-inset-top, 0px) + 4px)',
        'left:4px',
        'z-index:2147483647',
        'pointer-events:none',
        'font:9px/1.35 ui-monospace,monospace',
        'white-space:pre',
        'color:#7fff7f',
        'background:rgba(0,0,0,0.72)',
        'padding:4px 6px',
        'border-radius:4px',
        'max-width:70vw',
    ].join(';');
    document.body.appendChild(el);
    overlay = el;
    return el;
}

/** Record one labelled moment on the on-screen timeline. */
export function kbLog(label: string): void {
    if (!enabled()) return;
    const now = performance.now();
    if (lines.length === 0 || now - firstEventAt > RESET_AFTER_MS) {
        lines.length = 0;
        firstEventAt = now;
    }
    lines.push(`${String(Math.round(now - firstEventAt)).padStart(5)} ${label}`);
    while (lines.length > MAX_LINES) lines.shift();
    ensureOverlay().textContent = lines.join('\n');
}

let wired = false;

/**
 * Listen to the keyboard choreography events the app already dispatches, so
 * their timing lands on the same clock as the composer's own marks.
 */
export function wireKbTimeline(): void {
    if (!enabled() || wired) return;
    wired = true;

    const detailOf = (event: Event) =>
        (event as CustomEvent<Record<string, unknown>>).detail ?? {};

    window.addEventListener('oc:keyboard-intent', (event) => {
        kbLog(`kb-intent open=${String(detailOf(event).open)}`);
    });
    window.addEventListener('oc:keyboard-anim', (event) => {
        kbLog(`kb-anim ${String(detailOf(event).phase)}`);
    });
    window.addEventListener('oc:keyboard-settled', (event) => {
        kbLog(`kb-settled open=${String(detailOf(event).open)}`);
    });
    // Focus transitions drive both the keyboard and the collapse watcher.
    document.addEventListener('focusin', () => kbLog('focusin'), true);
    document.addEventListener('focusout', () => kbLog('focusout'), true);
    kbLog('timeline-armed');
}

/**
 * Mark the moments the browser is next allowed to paint after `label`. If
 * paint-1 lands before the keyboard starts moving, the swap was visible
 * immediately and whatever lags is inside the composer; if it lands only
 * around kb-settled, painting itself was blocked.
 */
export function kbLogPaints(label: string): void {
    if (!enabled()) return;
    requestAnimationFrame(() => {
        kbLog(`${label} paint-1`);
        requestAnimationFrame(() => kbLog(`${label} paint-2`));
    });
}
