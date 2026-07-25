import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import { COMPOSER_EDITOR_THEME_SPEC, composerEditorTheme } from '../theme';

const selectors = Object.keys(COMPOSER_EDITOR_THEME_SPEC);
const declarations = JSON.stringify(COMPOSER_EDITOR_THEME_SPEC);

describe('composerEditorTheme', () => {
    /**
     * EditorView.theme compiles its selectors when this module is imported and
     * throws RangeError on a scope it was not given — `&light` and `&dark`
     * among them, despite both appearing throughout CodeMirror's own base
     * theme. A build and a type-check both pass happily on that mistake; it
     * surfaces only in the running app, where it takes the composer down.
     */
    test('its selectors compile and the theme can be installed', () => {
        let failure: unknown = null;
        try {
            EditorState.create({ extensions: [composerEditorTheme] });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeNull();
    });

    /**
     * The composer runs `drawSelection()`, which hides the native caret with
     * `caret-color: transparent !important` and draws a `.cm-cursor` element
     * instead. Styling `caret-color` looks correct and does nothing, leaving
     * CodeMirror's hard-coded black cursor on dark themes.
     */
    test('the caret is coloured where it is drawn, not on the native caret', () => {
        expect(selectors.some((selector) => selector.includes('.cm-cursor'))).toBe(true);
        expect(declarations.includes('caretColor')).toBe(false);
    });

    test('the drawn caret follows the theme rather than a fixed colour', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        const rule = (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[cursorRule!];
        expect(rule.borderLeftColor.startsWith('var(--')).toBe(true);
    });

    /**
     * CodeMirror's own `.cm-cursor` rule and its `&dark` override are one and
     * two classes deep respectively; a bare `.cm-cursor` selector loses to the
     * latter. `&.cm-editor` matches it.
     */
    test('the caret rule is specific enough to beat the base theme', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        expect(cursorRule!.startsWith('&.cm-editor')).toBe(true);
    });
});
