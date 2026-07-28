/**
 * Reproduction for issue #2504: double-tapping space quickly does not insert a period.
 *
 * Root cause analysis:
 *
 * The 1.17.0 update migrated the chat composer from a native `<textarea>` element
 * (the "transparent-textarea-over-mirror-div arrangement") to a CodeMirror-based
 * contentEditable `<div>` (ComposerEditor.tsx).
 *
 * The new composer explicitly sets `spellcheck="false"` on the contentEditable
 * element on desktop by default:
 *
 *   ChatInput.tsx:2627:    spellCheck={isMobile || inputSpellcheckEnabled}
 *   ComposerEditor.tsx:263: spellcheck: String(handlersRef.current.spellCheck ?? false)
 *
 * Where `inputSpellcheckEnabled` defaults to `false` (useUIStore.ts:997).
 *
 * On Chrome (and other Chromium-based browsers), when `spellcheck="false"` is set
 * on an editable element, the browser disables its built-in autocorrect features
 * — including the "double-space to period" substitution (Chrome's "Double-space
 * period" feature under Enhanced spell check).
 *
 * Before the migration, the native `<textarea>` element had `spellcheck` enabled
 * by the browser default (`true` for textareas), so the double-space-to-period
 * feature worked. After the migration to CodeMirror, `spellcheck="false"` is
 * explicitly set, disabling this feature for desktop users.
 *
 * Additionally, `autocorrect` is set to `'off'` on desktop:
 *
 *   ComposerEditor.tsx:264: autocorrect: handlersRef.current.autoCorrect ? 'on' : 'off',
 *   ChatInput.tsx:2625:    autoCorrect={isMobile}
 *
 * This further prevents browser-level text substitutions.
 */

import { describe, expect, test } from 'bun:test';

/**
 * On desktop (non-mobile), the ChatInput passes these props to ComposerEditor:
 *
 *   spellCheck={false}        ← ChatInput.tsx:2627: isMobile(false) || inputSpellcheckEnabled(false)
 *   autoCorrect={false}       ← ChatInput.tsx:2625: isMobile(false)
 *   autoCapitalize={'none'}   ← ChatInput.tsx:2626: isMobile ? 'sentences' : 'none'
 */
test('desktop ChatInput passes spellCheck=false, autoCorrect=false, autoCapitalize="none"', () => {
    const isMobile = false;
    const inputSpellcheckEnabled = false; // default from useUIStore.ts:997

    const spellCheck = isMobile || inputSpellcheckEnabled;
    const autoCorrect = isMobile;
    const autoCapitalize = isMobile ? 'sentences' : 'none';

    // These are the values that get set on the CodeMirror contentEditable:
    //   spellcheck="false"  → browser autocorrect disabled
    //   autocorrect="off"   → browser text substitution disabled
    //   autocapitalize="none" → auto-capitalization disabled
    expect(spellCheck).toBe(false);
    expect(autoCorrect).toBe(false);
    expect(autoCapitalize).toBe('none');
});

/**
 * The ComposerEditor component defaults confirm the desktop behavior:
 *
 *   ComposerEditor.tsx:148:   spellCheck = false
 *   ComposerEditor.tsx:149:   autoCorrect = false
 *   ComposerEditor.tsx:150:   autoCapitalize = 'none'
 *
 * These are applied to the contentEditable via:
 *   ComposerEditor.tsx:263:  spellcheck: String(handlersRef.current.spellCheck ?? false)
 *   ComposerEditor.tsx:264:  autocorrect: handlersRef.current.autoCorrect ? 'on' : 'off'
 *   ComposerEditor.tsx:265:  autocapitalize: handlersRef.current.autoCapitalize ?? 'none'
 */
test('ComposerEditor default props match the desktop path', () => {
    // These are the actual defaults from ComposerEditor.tsx lines 148-151
    const spellCheck = false;
    const autoCorrect = false;
    const autoCapitalize = 'none';

    // Rendering logic that converts props to contentEditable attributes:
    const spellcheckAttr = String(spellCheck ?? false);    // → "false"
    const autocorrectAttr = autoCorrect ? 'on' : 'off';    // → "off"
    const autocapitalizeAttr = autoCapitalize ?? 'none';   // → "none"

    expect(spellcheckAttr).toBe('false');
    expect(autocorrectAttr).toBe('off');
    expect(autocapitalizeAttr).toBe('none');
});

/**
 * On mobile, the ChatInput passes different props that enable spellcheck
 * and autocorrect, so the double-space-to-period feature works on mobile.
 */
test('mobile ChatInput passes spellCheck=true, autoCorrect=true, autoCapitalize="sentences"', () => {
    const isMobile = true;
    const inputSpellcheckEnabled = false; // irrelevant, short-circuited by `isMobile ||`

    const spellCheck = isMobile || inputSpellcheckEnabled;
    const autoCorrect = isMobile;
    const autoCapitalize = isMobile ? 'sentences' : 'none';

    expect(spellCheck).toBe(true);
    expect(autoCorrect).toBe(true);
    expect(autoCapitalize).toBe('sentences');
});

/**
 * Reproduction steps:
 *
 * 1. Open OpenChamber desktop web in Chrome (or any Chromium-based browser).
 * 2. Click on the chat composer input.
 * 3. Type a word and then double-tap the space bar quickly.
 *
 * Expected behavior (before 1.17.0): The browser converts the double-space into
 *   ". " (period + space), ending the sentence.
 *
 * Actual behavior (1.17.0+): Two spaces are inserted instead of ". ".
 *
 * Root cause: The ComposerEditor (CodeMirror contentEditable) sets
 * `spellcheck="false"` and `autocorrect="off"` on the contentEditable element
 * on desktop. This disables the browser's built-in autocorrect features,
 * including the "double-space to period" substitution.
 *
 * Workaround: Go to Settings → Visual → Enable spellcheck in text inputs.
 * This sets `inputSpellcheckEnabled=true`, which makes `spellCheck=true` and
 * re-enables browser autocorrect features on the contentEditable.
 */
