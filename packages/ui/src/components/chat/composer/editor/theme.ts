/**
 * The composer editor's layout, typography and caret.
 *
 * Token colours are not here: they come from the shared highlight classes the
 * language layer emits, so the composer and the message list stay in step.
 */

import { EditorView } from '@codemirror/view';

/**
 * Exported for the regression test, which asserts the caret is styled where it
 * is actually drawn.
 */
export const COMPOSER_EDITOR_THEME_SPEC = {
    '&': {
        backgroundColor: 'transparent',
        color: 'var(--surface-foreground)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
        padding: '0',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        // The content box must cover the whole editor, not just the text, so
        // clicking the empty space below the last line still lands in it.
        minHeight: '100%',
    },
    // The caret is NOT the native one. `drawSelection()` hides that with
    // `caret-color: transparent !important` at the highest precedence and
    // draws its own `.cm-cursor` element, whose base style is a hard-coded
    // `border-left: 1.2px solid black`. Styling `caret-color` here therefore
    // does nothing at all — the border is what has to be coloured.
    //
    // CodeMirror recolours it for dark editors through `&dark .cm-cursor`,
    // which needs the theme to declare itself dark. OpenChamber themes are not
    // only light or dark, so the cursor takes the surface foreground directly
    // instead. `&.cm-editor` matches the specificity of that `&dark` rule, and
    // theme styles mount after the base theme, so this wins in every variant.
    //
    // The `&light` / `&dark` scopes are NOT usable here: EditorView.theme
    // builds its selectors without scopes and throws RangeError on them the
    // moment this module is imported.
    '&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
        borderLeftColor: 'var(--surface-foreground)',
    },
    '.cm-line': { padding: '0' },
    '.cm-scroller': {
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        overflowX: 'hidden',
    },
    '.cm-placeholder': { color: 'var(--surface-mutedForeground)' },
    '&.cm-editor .cm-selectionBackground, & .cm-selectionBackground': {
        backgroundColor: 'var(--interactive-selection)',
    },
};

export const composerEditorTheme = EditorView.theme(COMPOSER_EDITOR_THEME_SPEC);
