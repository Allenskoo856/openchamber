# Issue 2558 — Regression: Shift+Enter no longer works on iOS

Reproduction for https://github.com/openchamber/openchamber/issues/2558

On iOS (mobile web/PWA), pressing Shift+Enter in the chat composer submits
the message instead of inserting a newline. Worked in 1.16.3, broken in
1.17.0/1.17.1.

## Run

jsdom is not a repo dependency; point `JSDOM_PATH` at any jsdom install:

```sh
npm install --prefix /tmp/repro-jsdom jsdom@24
JSDOM_PATH=/tmp/repro-jsdom/node_modules/jsdom node repro/issue-2558/shift-enter-ios.mjs
```

The script exits `0` when the bug is reproduced and prints a three-scenario
summary (iOS non-mobile-classified / iOS mobile-classified / desktop).

## Result

| Scenario | Shift+Enter outcome |
| --- | --- |
| iOS, device not classified `isMobile` (e.g. iPad landscape) | **submitted** (bug) |
| iOS, device classified `isMobile` (iPhone) | newline inserted |
| Desktop | newline inserted |

## Root cause

v1.17.0 replaced the composer `<textarea>` with a CodeMirror editor
(`packages/ui/src/components/chat/composer/editor/ComposerEditor.tsx`, PR #2419).
On iOS, `@codemirror/view` intercepts the real Enter keydown
(`InputState.keydown` → `pendingIOSKey` → `flushIOSKey`) and re-dispatches a
*synthetic* keydown built from `{ key: "Enter", keyCode: 13 }` — the Shift
modifier is dropped. The composer handler (`ChatInput.tsx` `handleKeyDown`,
line ~1463) then sees `e.key === "Enter" && !e.shiftKey` and, because the
device is not classified as `isMobile` (`useDeviceInfo` reports `isMobile
=== false` for tablets/large screens, e.g. an iPad in landscape), takes the
submit branch:

```ts
if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ...handleSubmit();
}
```

On desktop the real Shift+Enter keydown keeps `shiftKey === true`, so the
same handler correctly skips submit and CodeMirror's `Shift-Enter` binding
inserts the newline.
