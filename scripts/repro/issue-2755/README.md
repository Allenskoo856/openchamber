# Reproduction: Shell mode `!` prefix not stripped synchronously (#2755)

Reproduces https://github.com/openchamber/openchamber/issues/2755 — typing `!`
in the chat input switches to shell mode but the `!` is not stripped from the
CodeMirror document synchronously, so a fast-typed command is sent with a
leading `!` (`!ls` instead of `ls`).

## Run

```sh
# Install happy-dom (used only by this repro, outside the workspace):
npm install --prefix /tmp/opencode/repro-2755 happy-dom

# Reproduce:
bun scripts/repro/issue-2755/reproduce-2755.tsx
```

## What it does

Mounts the REAL `ComposerEditor` component (real CodeMirror + real
controlled-value `useEffect`) with a verbatim copy of the `!`-handling branch
of `ChatInput.tsx` `handleComposerChange` (lines 1685-1697), then runs three
scenarios:

1. **Scenario A — issue repro**: type `!`, then immediately `ls`, then Enter.
   Result: the CodeMirror document (what `composerRef.current.getValue()`
   returns — exactly what ChatInput sends) is `!ls`. The `!` is never consumed.
2. **Scenario B — root cause**: after typing `!` and letting React + effects
   fully settle, the document STILL contains `!`. `setMessage('')` leaves the
   `value` prop unchanged ('' → ''), so ComposerEditor's `useEffect([value])`
   never re-runs and never rewrites the document; the caret fix is also only
   scheduled via `requestAnimationFrame`. Nothing touches the document
   synchronously.
3. **Scenario C — counterfactual**: the same repro with the synchronous
   `composerRef.current.replaceRange(0, value.length, shellCommand, nextCursor)`
   dispatch proposed in the issue applied to the harness. The `!` is stripped
   in the same tick and `ls` is sent cleanly — confirming the fix direction.

The script exits non-zero if the bug is not reproduced.

## Root cause (in the current code)

`handleComposerChange` in `packages/ui/src/components/chat/ChatInput.tsx`:

```ts
if (inputMode === 'normal' && value.startsWith('!')) {
    const shellCommand = value.slice(1);
    const nextCursor = Math.max(0, selection.start - 1);
    setInputMode('shell');
    setMessage(shellCommand);
    closeAutocomplete();
    requestAnimationFrame(() => composerRef.current?.setSelection(nextCursor));
    return;
}
```

- The `!` is only removed from React state (`setMessage`), never from the
  CodeMirror document. The document is only rewritten by the controlled-value
  `useEffect([value])` in `ComposerEditor.tsx`, which depends on the `value`
  prop actually changing.
- For the issue's repro (fresh/empty composer) `shellCommand` is `''`, so the
  `value` prop never changes ('' → ''), React bails on the effect, and the `!`
  stays in the document indefinitely.
- The caret fix is deferred to `requestAnimationFrame`, so the next keystroke
  concatenates after the stale `!` (`!ls`), and because `inputMode` is already
  `'shell'` the `!` guard no longer fires.
- On Enter, ChatInput sends `composerRef.current.getValue()` (the document),
  so `!ls` goes out.

## Files

- `reproduce-2755.tsx` — the reproduction driver (assertions + summary).
