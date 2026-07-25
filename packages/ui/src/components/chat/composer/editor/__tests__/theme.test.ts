import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import { composerEditorTheme } from '../theme';

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
});
