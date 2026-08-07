#!/usr/bin/env bun
/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2755
 *
 * [Bug] Shell mode `!` prefix not stripped synchronously — command sent with
 * leading `!` (ChatInput.tsx `handleComposerChange`, ~line 1686).
 *
 * Reported steps:
 *   1. Focus the chat input and type `!`
 *   2. Immediately type a shell command (e.g. `ls`)
 *   3. Press Enter to send
 *   Actual: the `!` remains in the editor and `!ls` is sent.
 *
 * Why it happens (verified below with the real components):
 *   - `handleComposerChange`'s shell branch only updates React state
 *     (`setMessage(shellCommand)`, `setInputMode('shell')`) and schedules a
 *     caret fix via `requestAnimationFrame`. It never touches the CodeMirror
 *     document synchronously.
 *   - The CodeMirror document is a *controlled* value: it is only rewritten by
 *     a passive `useEffect([value])` in ComposerEditor. When the composer is
 *     empty, `setMessage('')` leaves the `value` prop unchanged ('' -> ''), so
 *     React skips the effect entirely and the `!` is NEVER stripped from the
 *     document.
 *   - The caret is not repositioned synchronously either (it is deferred to a
 *     rAF), so a fast-typed command concatenates after the stale `!`.
 *   - On Enter, ChatInput sends `composerRef.current.getValue()` — the
 *     CodeMirror document — so the leading `!` goes out with the command.
 *
 * This script exercises the REAL `ComposerEditor` component and REAL
 * CodeMirror, with a verbatim copy of the `!`-handling branch of
 * `ChatInput.tsx` `handleComposerChange`. No scheduler/clock faking: the bug
 * reproduces deterministically.
 *
 * Run:
 *   bun scripts/repro/issue-2755/reproduce-2755.tsx
 *
 * Requires the `happy-dom` package (used only by this repro, not by the app):
 *   npm install --prefix /tmp/opencode/repro-2755 happy-dom
 */
import { Window } from '/tmp/opencode/repro-2755/node_modules/happy-dom/lib/index.js';

// ---------------------------------------------------------------------------
// 1. DOM globals (happy-dom) so React + CodeMirror can run.
// ---------------------------------------------------------------------------

const win = new Window({ url: 'http://localhost' });
// @ts-expect-error intentional global override
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.MutationObserver = win.MutationObserver;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);

/** requestAnimationFrame stub so the harness can observe the deferred caret fix. */
const rafQueue: Array<() => void> = [];
// @ts-expect-error stub signature
globalThis.requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
};
const flushRaf = () => {
    while (rafQueue.length > 0) rafQueue.shift()!();
};

// ---------------------------------------------------------------------------
// 2. Real app modules.
// ---------------------------------------------------------------------------

const React = await import('react');
const { flushSync } = await import('react-dom');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { ComposerEditor } = await import(
    '../../../packages/ui/src/components/chat/composer/editor/ComposerEditor'
);
import type { ComposerEditorHandle, ComposerChange } from '../../../packages/ui/src/components/chat/composer/editor/ComposerEditor';

// ---------------------------------------------------------------------------
// 3. Harness: REAL ComposerEditor + VERBATIM copy of the `!`-handling branch
//    of ChatInput.tsx `handleComposerChange` (lines 1685-1697).
//    `syncFix` (optional) mirrors the fix proposed in the issue so we can show
//    the counterfactual — it is NOT part of the current app behavior.
// ---------------------------------------------------------------------------

interface InputState {
    message: string;
    inputMode: 'normal' | 'shell';
}

function ShellModeInputHarness({ state, syncFix }: { state: InputState; syncFix?: boolean }) {
    const [message, setMessage] = React.useState('');
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const composerRef = React.useRef<ComposerEditorHandle>(null);

    // --- verbatim copy of ChatInput.tsx handleComposerChange (shell branch) ---
    const handleComposerChange = ({ value, selection }: ComposerChange) => {
        // A leading `!` switches the composer into shell mode and is consumed.
        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            if (syncFix) {
                // The fix proposed in the issue: dispatch the strip to
                // CodeMirror synchronously, in the same tick as the keystroke.
                composerRef.current?.replaceRange(0, value.length, shellCommand, nextCursor);
            }
            setMessage(shellCommand);
            requestAnimationFrame(() => composerRef.current?.setSelection(nextCursor));
            return;
        }
        setMessage(value);
    };
    // --- end copy ---

    state.message = message;
    state.inputMode = inputMode;

    return (
        <ComposerEditor
            ref={composerRef}
            value={message}
            onChange={handleComposerChange}
            languageContext={{
                inputMode,
                knownAgentNames: new Set(),
                confirmedMentions: new Set(),
                knownSlashNames: new Set(),
                knownSnippetTriggers: new Set(),
                attachmentFilenames: [],
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// 4. Mount helper + keystroke simulator.
// ---------------------------------------------------------------------------

let root: ReturnType<typeof createRoot> | null = null;
let mountEl: HTMLDivElement | null = null;

const mount = async (syncFix = false): Promise<{ state: InputState; view: EditorView }> => {
    if (root) root.unmount();
    if (mountEl) mountEl.remove();
    win.document.body.innerHTML = '';
    rafQueue.length = 0;

    const state: InputState = { message: '', inputMode: 'normal' };
    mountEl = win.document.createElement('div');
    win.document.body.appendChild(mountEl);
    root = createRoot(mountEl);
    flushSync(() => root.render(React.createElement(ShellModeInputHarness, { state, syncFix })));
    const content = win.document.querySelector('.cm-content');
    if (!content) throw new Error('CodeMirror content not found');
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('CodeMirror view not found');
    return { state, view };
};

/** Let React's microtask/task scheduling run (the commit for a keystroke). */
const settleReact = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
};

/** Simulate the user typing `text` at the current caret. */
const typeText = (view: EditorView, text: string) => {
    const { from, to } = view.state.selection.main;
    view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.type',
    });
};

/** What ChatInput sends on Enter: `composerRef.current.getValue()`. */
const valueThatWouldBeSent = (view: EditorView) => view.state.doc.toString();

// ---------------------------------------------------------------------------
// 5. Scenarios.
// ---------------------------------------------------------------------------

const log = (line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
};

let failures = 0;

/** The issue's exact repro: `!` then immediately `ls`, then Enter. */
const scenarioIssueRepro = async (): Promise<void> => {
    log('── Scenario A: issue repro — type "!", then immediately "ls", then Enter ──');
    const { state, view } = await mount();

    // Keystroke 1: `!` → CodeMirror doc becomes "!".
    typeText(view, '!');
    await settleReact(); // React commits inputMode='shell' (the `!` guard is now off)
    log(`  after typing "!"     : doc=${JSON.stringify(valueThatWouldBeSent(view))}  inputMode=${state.inputMode}  message=${JSON.stringify(state.message)}`);
    log(`  > '!' stripped from the CodeMirror document: ${valueThatWouldBeSent(view) === ''}  (it is still on screen)`);

    // Keystrokes 2-3: "ls" — typed before the deferred rAF caret fix runs
    // (fast typing / busy webview). The document still contains "!".
    typeText(view, 'ls');
    await settleReact();
    log(`  after typing "ls"    : doc=${JSON.stringify(valueThatWouldBeSent(view))}  inputMode=${state.inputMode}  message=${JSON.stringify(state.message)}`);

    // Enter: the app sends the CodeMirror document.
    const sent = valueThatWouldBeSent(view);
    log(`  value sent on Enter  : ${JSON.stringify(sent)}  (expected "ls")`);
    const reproduced = sent === '!ls';
    log(`  > BUG: command sent with leading '!': ${reproduced}`);
    if (!reproduced) failures += 1;
};

/** Prove the `!` is never stripped even after everything settles — the
 *  controlled-value effect never re-runs because `setMessage('')` leaves the
 *  `value` prop unchanged. */
const scenarioNeverStripped = async (): Promise<void> => {
    log('');
    log('── Scenario B: let ALL effects settle after typing "!" — is the "!" ever consumed? ──');
    const { state, view } = await mount();

    typeText(view, '!');
    await settleReact(); // commit
    flushRaf(); // the deferred caret fix
    await settleReact(); // any passive effects
    flushRaf();
    await settleReact();

    log(`  doc after typing "!" and letting everything settle: ${JSON.stringify(valueThatWouldBeSent(view))}`);
    log(`  inputMode=${state.inputMode}  message=${JSON.stringify(state.message)}`);
    const notStripped = valueThatWouldBeSent(view) === '!';
    log(`  > '!' still in the document after full settle: ${notStripped}`);
    log(`    (setMessage('') leaves value='' unchanged, so ComposerEditor's`);
    log(`    useEffect([value]) never re-runs and never rewrites the document)`);
    if (!notStripped) failures += 1;
};

/** Counterfactual: the synchronous `replaceRange` dispatch proposed in the
 *  issue strips the `!` in the same tick, so "ls" is sent cleanly. */
const scenarioWithProposedFix = async (): Promise<void> => {
    log('');
    log('── Scenario C (counterfactual): same repro with the issue\'s proposed fix');
    log('   (synchronous composerRef.replaceRange) applied to the harness ──');
    const { state, view } = await mount(true);

    typeText(view, '!');
    await settleReact();
    log(`  after typing "!"     : doc=${JSON.stringify(valueThatWouldBeSent(view))}  inputMode=${state.inputMode}`);
    typeText(view, 'ls');
    await settleReact();
    const sent = valueThatWouldBeSent(view);
    log(`  value sent on Enter  : ${JSON.stringify(sent)}`);
    const fixed = sent === 'ls';
    log(`  > command sent cleanly without '!': ${fixed}`);
    if (!fixed) failures += 1;
};

// ---------------------------------------------------------------------------
// 6. Run + verdict.
// ---------------------------------------------------------------------------

await scenarioIssueRepro();
await scenarioNeverStripped();
await scenarioWithProposedFix();

log('');
if (failures > 0) {
    log(`RESULT: FAIL (${failures} check(s) failed)`);
    process.exit(1);
}
log('RESULT: PASS — issue #2755 reproduced: the `!` prefix is not stripped from the');
log('CodeMirror document synchronously, and the command is sent with a leading `!`.');
