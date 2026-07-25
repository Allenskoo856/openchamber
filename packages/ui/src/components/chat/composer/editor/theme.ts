/**
 * The composer editor's layout, typography and caret.
 *
 * Token colours are not here: they come from the shared highlight classes the
 * language layer emits, so the composer and the message list stay in step.
 */

import { EditorView } from '@codemirror/view';

/** Layout and typography. Colour comes from the shared highlight classes. */
export const composerEditorTheme = EditorView.theme({
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
    // CodeMirror's base theme hard-codes the caret to black or white with
    // `.cm-editor.cm-light .cm-content`, which is one class more specific than
    // a bare `.cm-content` rule and therefore wins. `&.cm-editor` matches that
    // specificity, and theme rules mount after the base theme, so this takes
    // effect in both variants.
    //
    // The `&light` / `&dark` scopes are NOT usable here: EditorView.theme
    // builds its selectors without scopes and throws RangeError on them the
    // moment this module is imported.
    '&.cm-editor .cm-content': {
        caretColor: 'var(--surface-foreground)',
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
});
