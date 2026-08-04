# Issue #2627 — File tree only expands at depth 1

macOS desktop (Electron), v1.18.0. Directories nested inside an expanded
directory do not expand when clicked; only the first layer expands.

## Root cause

The FileRow `<button>` in `packages/ui/src/components/layout/SidebarFilesTree.tsx`
(line ~343) is marked `draggable` and styled `cursor-grab`. A draggable
element makes the browser start a drag-and-drop gesture as soon as the pointer
moves a few pixels between mousedown and mouseup — and when a drag starts, the
browser **suppresses the `click` event entirely**.

The row's `onClick={handleInteraction}` is what calls `toggleDirectory` →
`toggleExpandedPath`, so a suppressed click means the directory never expands.
On macOS trackpads / Magic Mouse, small pointer movements during a click are
the norm, so folder clicks are frequently swallowed. The tree logic itself is
fine — the click simply never reaches it.

`FilesView.tsx`'s FileRow button has no `draggable` attribute and does not
suffer from this.

## Evidence

1. `reproduce-2627.test.tsx` — structural regression guard. It asserts the
   SidebarFilesTree FileRow button is not a drag source; it **fails on the
   current code** (the `draggable` attribute is present), proving the bug is
   live. The control test shows FilesView has no `draggable`.

2. `drag-cdp.mjs` (with `drag-suppression.html`) — browser-level proof over the
   Chrome DevTools Protocol using real input events:

   ```
   {"dist":2,"draggable":{"click":1,"drag":0},"plain":{"click":1,"drag":0}}
   {"dist":3,"draggable":{"click":1,"drag":0},"plain":{"click":1,"drag":0}}
   {"dist":4,"draggable":{"click":0,"drag":1},"plain":{"click":1,"drag":0}}
   {"dist":6,"draggable":{"click":0,"drag":1},"plain":{"click":1,"drag":0}}
   {"dist":8,"draggable":{"click":0,"drag":1},"plain":{"click":1,"drag":0}}
   REPRODUCED
   ```

   From 4px of pointer movement during a click, the draggable row starts a drag
   and its click handler never fires; the non-draggable control still fires.

3. `packages/ui/src/components/layout/__tests__/sidebarFilesTreeDepthRepro.test.tsx` —
   component harness that mounts the real `SidebarFilesTree` and expands a
   depth-2 directory through the actual click handler. It passes, confirming
   that when the click event does reach the button, expansion works at any
   depth. The failure is click delivery, not tree logic.

## Run

```sh
bun test reproduce/issue-2627/reproduce-2627.test.tsx   # fails while bug is present
bun test packages/ui/src/components/layout/__tests__/sidebarFilesTreeDepthRepro.test.tsx
node reproduce/issue-2627/drag-cdp.mjs                  # requires chromium (CHROME_BIN override)
```

## Suggested fix (for maintainers)

Remove `draggable`, `onDragStart`, and the `cursor-grab`/`active:cursor-grabbing`
classes from the row `<button>` in `SidebarFilesTree.tsx`, matching the
`FilesView.tsx` row. If drag-and-drop of file paths from the sidebar is still
desired, attach it to a dedicated drag handle instead of the primary click
target.
