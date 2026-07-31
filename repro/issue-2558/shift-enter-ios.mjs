/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2558
 *
 * "[Bug] Regression - Shift+enter no longer works on ios"
 *
 * On iOS (mobile web/PWA), pressing Shift+Enter in the chat composer
 * submits the message instead of inserting a newline. Worked in 1.16.3,
 * broken since 1.17.0.
 *
 * Root cause:
 * v1.17.0 replaced the composer's <textarea> with a CodeMirror editor
 * (packages/ui/src/components/chat/composer/editor/ComposerEditor.tsx,
 * introduced by PR #2419). On iOS, @codemirror/view special-cases Enter:
 * InputState.keydown() stores the event as `pendingIOSKey` and lets the
 * browser insert the newline natively, then re-dispatches a *synthetic*
 * keydown through the keymap so key handlers still run (see
 * `flushIOSKey`/`dispatchKey` in node_modules/@codemirror/view).
 *
 * That synthetic keydown is rebuilt from `{ key: "Enter", keyCode: 13 }`
 * — the Shift modifier is dropped. The composer's key handler
 * (packages/ui/src/components/chat/ChatInput.tsx, `handleKeyDown`) then
 * sees `e.key === "Enter" && !e.shiftKey` and, whenever the device is not
 * classified as `isMobile` (e.g. an iPad in landscape reports
 * `isMobile === false` from `useDeviceInfo`), takes the submit branch:
 *
 *   if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
 *       e.preventDefault();
 *       ... handleSubmit();
 *   }
 *
 * On a desktop browser the real Shift+Enter keydown keeps `shiftKey === true`,
 * so the same handler correctly skips the submit branch and CodeMirror's
 * "Shift-Enter" binding inserts the newline.
 *
 * This script reproduces the regression headlessly: it boots the actual
 * CodeMirror version used by OpenChamber with the composer's exact keymap
 * setup and feeds it an iOS user agent.
 *
 * Usage:
 *   JSDOM_PATH=/path/to/jsdom node repro/issue-2558/shift-enter-ios.mjs
 *
 * The script exits 0 when the buggy behaviour is observed (submission on
 * Shift+Enter for a non-mobile-classified iOS device) and prints a summary.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const jsdomPath = process.env.JSDOM_PATH ?? resolve(here, 'node_modules/jsdom');

const IOS_IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function runScenario(name, userAgent, isMobile, maxTouchPoints) {
    const { JSDOM } = await import(`${jsdomPath}/lib/api.js`);
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://localhost/',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    // jsdom 24 ignores the userAgent option; force it (and maxTouchPoints)
    // directly so CodeMirror's platform detection (browser.ios) sees iOS.
    Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
    // CodeMirror reads browser globals at module load; install them first.
    globalThis.window = window;
    globalThis.document = window.document;
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.InputEvent = window.InputEvent;
    globalThis.Event = window.Event;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.MouseEvent = window.MouseEvent;
    globalThis.Text = window.Text;
    globalThis.Node = window.Node;
    globalThis.Element = window.Element;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Range = window.Range;
    globalThis.DOMRect = window.DOMRect;
    globalThis.getSelection = window.getSelection.bind(window);
    globalThis.MutationObserver = window.MutationObserver;
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

    // jsdom has no layout engine; give CodeMirror's measuring code empty rects.
    const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
    window.Range.prototype.getClientRects = emptyRects;
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    window.Text.prototype.getClientRects = emptyRects;
    window.Element.prototype.getClientRects = emptyRects;
    window.Element.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { value: 0, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { value: 0, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { value: 0, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { value: 0, configurable: true });

    // Re-import CodeMirror per scenario: the browser flags are computed at
    // module load from the navigator we just installed.
    const { EditorView, keymap, drawSelection } = await import('@codemirror/view');
    const { EditorState, Prec } = await import('@codemirror/state');
    const { history, historyKeymap, standardKeymap } = await import('@codemirror/commands');

    const actions = [];
    const handler = makeComposerKeyHandler(
        {
            isMobile,
            message: 'hello',
            hasContent: true,
            currentSessionId: 'session-1',
            sessionPhase: 'idle',
            autoReviewRunning: false,
            followUpBehavior: 'steer',
            inputMode: 'normal',
        },
        (a) => actions.push(a),
    );

    // Same wiring as ComposerEditor.tsx: the composer's key handler runs at
    // highest precedence and reports consumption through defaultPrevented.
    const interceptKeys = [{
        any: (_view, event) => {
            handler(event);
            return event.defaultPrevented;
        },
    }];

    const view = new EditorView({
        state: EditorState.create({
            doc: 'hello',
            extensions: [
                history(),
                drawSelection(),
                Prec.highest(keymap.of(interceptKeys)),
                keymap.of([...standardKeymap, ...historyKeymap]),
                EditorView.lineWrapping,
            ],
        }),
        parent: document.body,
    });

    view.focus();
    const before = view.state.doc.toString();

    // Real Shift+Enter keydown, exactly as iOS/a hardware keyboard reports it.
    const ev = new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 13, which: 13,
        shiftKey: true, bubbles: true, cancelable: true,
    });
    view.contentDOM.dispatchEvent(ev);

    // On iOS, CodeMirror defers the keydown and re-dispatches a synthetic one
    // ~250ms later (pendingIOSKey / flushIOSKey). Give it time to land.
    await sleep(500);

    const after = view.state.doc.toString();
    const submitted = actions.length > 0;
    const newlineInserted = after !== before;

    view.destroy();
    dom.window.close();
    return { name, submitted, newlineInserted, actions, before, after };
}

// Ported verbatim from packages/ui/src/lib/ime.ts
const isIMECompositionEvent = (e) => {
    const native = 'nativeEvent' in e ? e.nativeEvent : e;
    return native.isComposing || native.keyCode === 229;
};

/**
 * Ported from ChatInput.tsx `handleKeyDown` (Enter-relevant branches).
 * `openAutocomplete` is closed and no shortcut is configured in the repro,
 * so the autocomplete/history/cycle-agent branches are inert; the Enter
 * branch is byte-for-byte equivalent.
 */
function makeComposerKeyHandler(opts, onAction) {
    const { isMobile, message, hasContent, currentSessionId, sessionPhase, autoReviewRunning, followUpBehavior, inputMode } = opts;
    return (e) => {
        if (isIMECompositionEvent(e)) return;

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            return;
        }
        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            return;
        }

        // Handle Enter/Ctrl+Enter based on selected follow-up behavior.
        if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const isCtrlEnter = e.ctrlKey || e.metaKey;
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && (sessionPhase !== 'idle' || autoReviewRunning);
            if (followUpBehavior === 'queue') {
                onAction(isCtrlEnter || !canQueue ? 'submit' : 'queue');
            } else {
                onAction(isCtrlEnter || !canQueue ? 'submit' : 'submit(steer)');
            }
        }
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
    { key: 'ios-non-mobile', name: 'iOS (iPad landscape classification, isMobile=false)', ua: IOS_IPAD_UA, isMobile: false, maxTouchPoints: 5 },
    { key: 'ios-mobile', name: 'iOS (iPhone classification, isMobile=true)', ua: IOS_IPAD_UA, isMobile: true, maxTouchPoints: 5 },
    { key: 'desktop', name: 'Desktop browser (isMobile=false)', ua: DESKTOP_UA, isMobile: false, maxTouchPoints: 0 },
];

// Each scenario runs in its own process so the once-per-process CodeMirror
// platform flags (browser.ios) match the scenario's user agent.
const scenarioKey = process.env.SCENARIO;
if (scenarioKey) {
    const scenario = SCENARIOS.find((s) => s.key === scenarioKey);
    const result = await runScenario(scenario.name, scenario.ua, scenario.isMobile, scenario.maxTouchPoints);
    process.stdout.write(JSON.stringify(result) + '\n');
} else {
    const results = {};
    for (const scenario of SCENARIOS) {
        const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            env: { ...process.env, SCENARIO: scenario.key, JSDOM_PATH: jsdomPath },
            encoding: 'utf8',
        });
        if (out.status !== 0) {
            console.error(`scenario ${scenario.key} failed:\n${out.stderr}`);
            process.exit(2);
        }
        results[scenario.key] = JSON.parse(out.stdout.trim().split('\n').pop());
    }

    for (const scenario of SCENARIOS) {
        const r = results[scenario.key];
        console.log(`\n[${scenario.name}]`);
        console.log(`  actions   : ${JSON.stringify(r.actions)}`);
        console.log(`  doc before: ${JSON.stringify(r.before)}`);
        console.log(`  doc after : ${JSON.stringify(r.after)}`);
        console.log(`  submitted : ${r.submitted}`);
        console.log(`  newline   : ${r.newlineInserted}`);
    }

    console.log('\n==============================================================');
    console.log('VERDICT');
    console.log('==============================================================');
    const ios = results['ios-non-mobile'];
    const desktop = results['desktop'];
    console.log(`iOS (non-mobile-classified) Shift+Enter: submitted=${ios.submitted} — the issue says it submits instead of inserting a newline.`);
    console.log(`Desktop control Shift+Enter             : submitted=${desktop.submitted} — must stay false (newline expected).`);

    if (ios.submitted && !desktop.submitted) {
        console.log('\nREPRODUCED: On iOS, Shift+Enter submits the message. The CodeMirror');
        console.log('synthetic Enter re-dispatch (pendingIOSKey/flushIOSKey) drops the Shift');
        console.log('modifier, so the composer treats Shift+Enter as a plain Enter and takes');
        console.log('the submit branch whenever the device is not classified as isMobile');
        console.log('(iPad landscape / tablet classification via useDeviceInfo).');
        process.exit(0);
    }
    console.log('\nNOT reproduced with this configuration.');
    process.exit(1);
}
