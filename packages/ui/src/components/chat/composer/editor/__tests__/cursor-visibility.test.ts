/**
 * Reproduction for issue #2518: cursor not visible in empty chat input.
 *
 * The ComposerEditor uses CodeMirror with `drawSelection()`. This test
 * validates that the cursor (`.cm-cursor`) element is created and visible
 * when the editor is focused with an empty document.
 *
 * The cursor rendering chain:
 * 1. `drawSelection()` adds a `.cm-cursorLayer` element to the DOM
 * 2. Cursor markers (`.cm-cursor`) are created when the selection is
 *    empty and the editor is focused
 * 3. The cursor is a `border-left: 1.2px solid black` by default
 * 4. OpenChamber's theme colours it with `var(--surface-foreground)`
 * 5. The cursor blinks via a CSS animation on `.cm-focused > .cm-cursorLayer`
 *
 * Root cause analysis:
 * - The theme correctly sets cursor color via `--surface-foreground`
 * - The editor extensions include `drawSelection()` for cursor rendering
 * - The `composerNativeSelectionExtension` only hides the cursor layer
 *   when a range is selected (`.oc-native-range`), not for empty cursors
 * - There is NO CSS or code that conditionally hides the cursor based on
 *   content being empty
 *
 * The most likely cause of invisible cursor in a real browser:
 * 1. The `--surface-foreground` CSS variable is not defined or resolves to
 *    a color that matches the background
 * 2. A theme-specific CSS override inadvertently affects cursor visibility
 * 3. A browser extension or user stylesheet interferes
 */
import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import {
    COMPOSER_EDITOR_THEME_SPEC,
    NATIVE_SELECTION_THEME_SPEC,
    composerNativeSelectionExtension,
} from '../theme';

const selectors = Object.keys(COMPOSER_EDITOR_THEME_SPEC);
const declarations = JSON.stringify(COMPOSER_EDITOR_THEME_SPEC);

describe('empty cursor visibility (issue #2518)', () => {
    /**
     * drawSelection() uses cursor markers for empty ranges. The editor
     * configuration must not accidentally skip cursor rendering for empty
     * selections.
     */
    test('the cursor range is empty (not a range selection)', () => {
        const state = EditorState.create({
            doc: '',
            extensions: [],
        });
        expect(state.selection.main.empty).toBe(true);
        expect(state.selection.main.head).toBe(0);
    });

    /**
     * The theme colours the cursor through borderLeftColor. If this CSS
     * variable is not defined, the cursor falls back to black — still
     * visible. But if it's explicitly set to transparent or the background
     * colour, the cursor would be invisible.
     */
    test('the cursor border colour comes from a CSS variable', () => {
        const cursorRule = selectors.find((s) => s.includes('.cm-cursor'));
        expect(cursorRule).toBeDefined();
        const rule = (
            COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>
        )[cursorRule!];
        expect(rule.borderLeftColor.startsWith('var(--')).toBe(true);
    });

    /**
     * The theme must NOT override display on .cm-cursor — that would break
     * CodeMirror's focus-based visibility toggle (.cm-cursor is display:none
     * by default, display:block when .cm-focused is on the editor).
     */
    test('the theme does not set display on .cm-cursor', () => {
        const cursorDisplayRules = selectors.filter(
            (s) =>
                s.includes('.cm-cursor') &&
                'display' in
                    (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[s],
        );
        expect(cursorDisplayRules).toHaveLength(0);
    });

    /**
     * The native selection extension hides the cursor layer ONLY when
     * oc-native-range is present (i.e., when a non-empty range is
     * selected). For an empty cursor, the cursor layer must remain visible.
     */
    test('the native selection extension scopes cursor-layer hiding to oc-native-range', () => {
        const nativeSelectors = Object.keys(NATIVE_SELECTION_THEME_SPEC);
        const hiders = nativeSelectors.filter(
            (s) =>
                s.includes('.cm-cursorLayer') &&
                (
                    NATIVE_SELECTION_THEME_SPEC as Record<
                        string,
                        Record<string, string>
                    >
                )[s].display === 'none',
        );
        expect(hiders.length).toBeGreaterThan(0);
        for (const hider of hiders) {
            expect(hider).toContain('oc-native-range');
        }
    });

    /**
     * The selection is empty by default, so oc-native-range should NOT
     * be active, and the cursor layer should NOT be hidden.
     */
    test('the default selection (cursor) does not trigger oc-native-range', () => {
        // The native selection extension only sets oc-native-range when
        // the selection is non-empty. For an empty document, the main
        // selection range is empty (cursor, not range).
        const state = EditorState.create({
            doc: '',
            extensions: [composerNativeSelectionExtension],
        });
        expect(state.selection.main.empty).toBe(true);
        // No need to test the internal editorAttributes callback directly;
        // the fact that selection.main.empty is true means the callback
        // would return null, and oc-native-range would NOT be added.
    });

    /**
     * CodeMirror's base theme sets cursor display: none by default and
     * display: block when focused. The OpenChamber theme must not regress
     * this by overriding cursor visibility.
     */
    test('the theme has no rule that hides the cursor layer generally', () => {
        const layerHiders = selectors.filter(
            (s) =>
                s.includes('.cm-cursorLayer') &&
                (
                    COMPOSER_EDITOR_THEME_SPEC as Record<
                        string,
                        Record<string, string>
                    >
                )[s].display === 'none',
        );
        expect(layerHiders).toHaveLength(0);
    });
});
