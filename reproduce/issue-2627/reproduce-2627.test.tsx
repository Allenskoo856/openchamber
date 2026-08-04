/**
 * Reproduction test for issue #2627 - "File tree only expands at depth 1".
 * https://github.com/openchamber/openchamber/issues/2627
 *
 * Reported on Desktop (macOS), version 1.18.0: directories nested inside an
 * expanded directory do not expand when clicked; only the first layer can be
 * expanded.
 *
 * Root cause: the FileRow `<button>` in `SidebarFilesTree.tsx` is marked
 * `draggable`. A draggable element makes the browser begin a drag-and-drop
 * gesture when the pointer moves even a few pixels between mousedown and
 * mouseup, which suppresses the `click` event entirely. On macOS trackpads /
 * Magic Mouse this is the norm, so the directory's onClick (which toggles the
 * expanded path) never runs.
 *
 * Evidence:
 *  - `SidebarFilesTree.tsx` FileRow: `<button ... draggable onDragStart={handleDragStart}>`
 *  - `FilesView.tsx` FileRow: `<button ... onClick={handleInteraction}>` (no `draggable`)
 *  - Browser-level proof in `drag-cdp.mjs` (run against `drag-suppression.html`):
 *    at >=4px of pointer movement during a click, the draggable button starts a
 *    drag and its click handler does NOT fire; the non-draggable button still
 *    fires its click handler.
 *  - `sidebarFilesTreeDepthRepro.test.tsx` (component harness) shows the tree
 *    expands at any depth when the click handler actually runs - confirming the
 *    failure is click delivery, not tree logic.
 *
 * This test is a structural regression guard: it must FAIL while the row
 * button is draggable (i.e. while the bug is present) and PASS once the
 * draggable attribute is removed from the row button.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidebarFilesTreeSource = readFileSync(
  join(__dirname, '..', '..', 'packages', 'ui', 'src', 'components', 'layout', 'SidebarFilesTree.tsx'),
  'utf-8',
);
const filesViewSource = readFileSync(
  join(__dirname, '..', '..', 'packages', 'ui', 'src', 'components', 'views', 'FilesView.tsx'),
  'utf-8',
);

describe('issue #2627 - FileRow click suppression by draggable', () => {
  test('SidebarFilesTree FileRow button is NOT draggable (currently fails: bug present)', () => {
    // Find the FileRow <button> in SidebarFilesTree.tsx. It is the first
    // occurrence of `<button` after the FileRow component start. The row
    // button currently carries `draggable` (line ~343), which suppresses
    // click events when the pointer moves a few pixels during the click.
    const fileRowStart = sidebarFilesTreeSource.indexOf('const FileRow: React.FC<FileRowProps>');
    const fileRowEnd = sidebarFilesTreeSource.indexOf('const areFileRowPropsEqual');
    const fileRowBlock = sidebarFilesTreeSource.slice(fileRowStart, fileRowEnd);

    const buttonTag = fileRowBlock.match(/<button\b[^>]*>/);
    expect(buttonTag).not.toBeNull();

    // The row button must NOT be a drag source.
    expect(buttonTag![0]).not.toMatch(/draggable/);
  });

  test('FilesView FileRow button has no draggable attribute (control)', () => {
    const fileRowStart = filesViewSource.indexOf('const FileRow: React.FC<FileRowProps>');
    const fileRowEnd = filesViewSource.indexOf('const areFileRowPropsEqual');
    const fileRowBlock = filesViewSource.slice(fileRowStart, fileRowEnd);

    const buttonTag = fileRowBlock.match(/<button\b[^>]*>/);
    expect(buttonTag).not.toBeNull();
    expect(buttonTag![0]).not.toMatch(/draggable/);
  });
});
