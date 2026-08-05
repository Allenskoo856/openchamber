/**
 * Reproduction guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * "[Bug] Escape in terminal closes pane so can't exit Vim"
 *
 * On Desktop Web, pressing Escape while the terminal tab has focus closes the
 * whole context panel instead of forwarding the keypress to the PTY (e.g. so
 * Vim can exit insert mode).
 *
 * Mechanism (verified below):
 * 1. `ContextPanel` wraps every surface — including `TerminalView` — in an
 *    `<aside>` that carries `onKeyDownCapture={handlePanelKeyDownCapture}`.
 * 2. That capture-phase handler closes the panel on ANY Escape keydown
 *    (`event.preventDefault(); event.stopPropagation(); handleClose();`),
 *    with no exception for events originating inside the terminal.
 * 3. The terminal (`ghostty-web`) registers its own keydown listener on the
 *    terminal container in the BUBBLE phase (plain `addEventListener("keydown", ...)`).
 *    DOM capture phase always runs before bubble phase, so the panel's
 *    capture-phase handler fires first, stops propagation, and the terminal
 *    never receives the Escape key — while `closeContextPanel` collapses the
 *    panel the terminal lives in.
 *
 * The mobile drawer already contains the missing guard
 * (`if (event.key === 'Escape' && tabRef.current !== 'terminal')` in
 * `MobileWorkspaceDrawer.tsx`); the desktop ContextPanel has no equivalent.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');
const terminalViewportSource = readFileSync(
    join(__dirname, '..', '..', 'terminal', 'TerminalViewport.tsx'),
    'utf-8',
);
const mobileWorkspaceDrawerSource = readFileSync(
    join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
    'utf-8',
);

const ghosttyDist = join(__dirname, '..', '..', '..', '..', '..', '..', 'node_modules', 'ghostty-web', 'dist', 'ghostty-web.js');

describe('issue #2644: Escape closes the context panel instead of reaching the terminal', () => {
    test('the context panel captures Escape at the panel level', () => {
        expect(contextPanelSource).toContain('onKeyDownCapture={handlePanelKeyDownCapture}');
    });

    test('the capture handler closes the whole panel on any Escape, without a terminal exception', () => {
        const start = contextPanelSource.indexOf('const handlePanelKeyDownCapture = React.useCallback(');
        expect(start).toBeGreaterThan(-1);
        const end = contextPanelSource.indexOf('}, [handleClose]);', start);
        expect(end).toBeGreaterThan(start);
        const handler = contextPanelSource.slice(start, end);

        expect(handler).toContain("event.key !== 'Escape'");
        expect(handler).toContain('event.preventDefault()');
        expect(handler).toContain('event.stopPropagation()');
        expect(handler).toContain('handleClose()');

        // handleClose delegates to closeContextPanel(directoryKey), which sets
        // contextPanelByDirectory[directory].isOpen = false.
        const closeStart = contextPanelSource.indexOf('const handleClose = React.useCallback(');
        const closeEnd = contextPanelSource.indexOf('}, [closeContextPanel, directoryKey]);', closeStart);
        const handleClose = contextPanelSource.slice(closeStart, closeEnd);
        expect(handleClose).toContain('closeContextPanel(directoryKey)');

        // The regression: no guard that skips closing when the event target is
        // the terminal (compare with the mobile drawer, which has one).
        expect(handler).not.toContain('terminal');
    });

    test('the terminal surface is rendered inside the Escape-capturing panel', () => {
        const asideStart = contextPanelSource.indexOf('onKeyDownCapture={handlePanelKeyDownCapture}');
        const panelEnd = contextPanelSource.length;
        const panelBody = contextPanelSource.slice(asideStart, panelEnd);
        expect(panelBody).toContain('<TerminalView');
        expect(panelBody).toContain("activeTab?.mode === 'terminal'");
    });

    test('the terminal viewport registers no keydown interception of its own', () => {
        expect(terminalViewportSource.indexOf("addEventListener('keydown'")).toBe(-1);
        expect(terminalViewportSource.indexOf('addEventListener("keydown"')).toBe(-1);
        // The only path from keyboard to PTY is ghostty-web's onData callback.
        expect(terminalViewportSource).toContain('terminal.onData((data) => inputRef.current(data))');
    });

    test('ghostty-web listens for keydown on the container in the bubble phase', () => {
        const ghosttySource = readFileSync(ghosttyDist, 'utf-8');
        // The terminal registers its keydown listener with a bare
        // addEventListener (no capture flag), i.e. bubble phase. The panel's
        // React onKeyDownCapture runs during the capture phase first.
        const attach = ghosttySource.match(
            /this\.container\.addEventListener\(["']keydown["'],\s*this\.keydownListener\)/,
        );
        expect(attach).not.toBeNull();
        expect(attach![0]).not.toContain('true');
    });

    test('mobile drawer has the terminal exception the desktop panel lacks', () => {
        const handlerStart = mobileWorkspaceDrawerSource.indexOf("if (event.key === 'Escape'");
        expect(handlerStart).toBeGreaterThan(-1);
        const handler = mobileWorkspaceDrawerSource.slice(handlerStart, handlerStart + 200);
        expect(handler).toContain("tabRef.current !== 'terminal'");
    });
});

// ---------------------------------------------------------------------------
// Deterministic DOM-event-propagation simulation (no browser needed).
//
// Models the relevant part of the DOM spec: a keydown dispatched at a node
// inside the terminal runs ancestor capture-phase listeners first, then target
// listeners, then ancestor bubble-phase listeners. stopPropagation() during
// capture prevents both target and bubble listeners from ever firing.
// ---------------------------------------------------------------------------

type Listener = { capture: boolean; onEvent: (event: SimulatedEvent) => void };
type SimulatedEvent = {
    type: string;
    defaultPrevented: boolean;
    propagationStopped: boolean;
    target: SimNode;
    preventDefault(): void;
    stopPropagation(): void;
};

class SimNode {
    readonly children: SimNode[] = [];
    private listeners: Listener[] = [];
    private parent: SimNode | null = null;

    addListener(listener: Listener): void {
        this.listeners.push(listener);
    }

    attach(child: SimNode): void {
        child.parent = this;
        this.children.push(child);
    }

    dispatch(type: string): SimulatedEvent {
        // Build the propagation path from the root ancestor down to the target.
        const buildPath = (target: SimNode): SimNode[] => {
            const ancestors: SimNode[] = [];
            let cursor: SimNode | null = target;
            while (cursor !== null) {
                ancestors.push(cursor);
                cursor = cursor.parent;
            }
            ancestors.reverse();
            return ancestors;
        };
        const path = buildPath(this);

        const event: SimulatedEvent = {
            type,
            defaultPrevented: false,
            propagationStopped: false,
            target: this,
            preventDefault() { event.defaultPrevented = true; },
            stopPropagation() { event.propagationStopped = true; },
        };

        // Capture phase: ancestors first, outermost to innermost.
        for (let i = 0; i < path.length; i += 1) {
            if (event.propagationStopped) return event;
            for (const listener of path[i].listeners) {
                if (!listener.capture) continue;
                listener.onEvent(event);
                if (event.propagationStopped) return event;
            }
        }
        // Bubble phase: innermost to outermost (skip target already visited
        // in capture; ghostty's listener is bubble-phase on the container).
        for (let i = path.length - 1; i >= 0; i -= 1) {
            if (event.propagationStopped) return event;
            for (const listener of path[i].listeners) {
                if (listener.capture) continue;
                listener.onEvent(event);
                if (event.propagationStopped) return event;
            }
        }
        return event;
    }
}

describe('issue #2644: event propagation ordering simulation', () => {
    test('capture-phase panel handler fires before bubble-phase terminal handler', () => {
        const panel = new SimNode(); // ContextPanel <aside onKeyDownCapture=...>
        const terminalContainer = new SimNode(); // ghostty-web container div
        panel.attach(terminalContainer);

        const calls: string[] = [];
        const panelEscapeHandler = (event: SimulatedEvent) => {
            if (event.type !== 'keydown' || event.propagationStopped) return;
            calls.push('panel-capture');
            // handlePanelKeyDownCapture does exactly this on Escape:
            event.preventDefault();
            event.stopPropagation();
        };
        const terminalKeydownHandler = (event: SimulatedEvent) => {
            calls.push('terminal-bubble');
            // In the real app this forwards the Escape byte (\x1b) to the PTY.
            void event;
        };

        panel.addListener({ capture: true, onEvent: panelEscapeHandler });
        terminalContainer.addListener({ capture: false, onEvent: terminalKeydownHandler });

        const event = terminalContainer.dispatch('keydown');

        // The panel's capture handler ran first, the terminal's bubble handler
        // never ran, and the default action was prevented — exactly the bug:
        // Escape is swallowed and the panel closes.
        expect(calls).toEqual(['panel-capture']);
        expect(event.propagationStopped).toBe(true);
        expect(event.defaultPrevented).toBe(true);
    });

    test('without the capture handler the terminal receives the Escape', () => {
        const panel = new SimNode();
        const terminalContainer = new SimNode();
        panel.attach(terminalContainer);

        const calls: string[] = [];
        terminalContainer.addListener({
            capture: false,
            onEvent: () => calls.push('terminal-bubble'),
        });

        terminalContainer.dispatch('keydown');
        expect(calls).toEqual(['terminal-bubble']);
    });
});
