/**
 * Reproduction test for issue #2474: inconsistent terminal input between
 * devices and selected default keyboards.
 *
 * The `beforeinput` handler in TerminalViewport.tsx (lines 235-263) only
 * handles four inputTypes:
 *   - insertText
 *   - insertLineBreak / insertParagraph  →  \r
 *   - deleteContentBackward              →  \x7f
 *
 * Everything else falls through to the `default` case and is silently
 * dropped.  This reproduction test enumerates the common Android IME
 * inputType values and verifies which ones are / are not forwarded.
 */
import { describe, expect, test } from 'bun:test';

/**
 * Simulates the beforeinput handler logic from TerminalViewport.tsx.
 *
 * The real handler (line 243-260):
 * ```
 * const handleBeforeInput = (event: Event) => {
 *   const input = event as InputEvent;
 *   if (input.isComposing) return;
 *   switch (input.inputType) {
 *     case 'insertText':
 *       if (input.data) inputRef.current(input.data);
 *       break;
 *     case 'insertLineBreak':
 *     case 'insertParagraph':
 *       inputRef.current('\r');
 *       break;
 *     case 'deleteContentBackward':
 *       inputRef.current('\x7f');
 *       break;
 *     default:
 *       break;
 *   }
 * };
 * ```
 * Returns the character forwarded to the terminal, or null if the event
 * is swallowed.
 */
function simulateBeforeInputHandler(
  inputType: string,
  data: string | null,
  isComposing: boolean,
): string | null {
  if (isComposing) return null;

  switch (inputType) {
    case 'insertText':
      return data;
    case 'insertLineBreak':
    case 'insertParagraph':
      return '\r';
    case 'deleteContentBackward':
      return '\x7f';
    default:
      return null;
  }
}

/**
 * Common Android IME `inputType` values that reach the terminal.
 * https://w3c.github.io/input-events/#interface-InputEvent-Attributes
 */
const INPUT_TYPES = {
  // --- Text insertion ---
  /** Direct character input (handled) */
  INSERT_TEXT: 'insertText',
  /** Paste from clipboard (NOT handled → pasting fails) */
  INSERT_FROM_PASTE: 'insertFromPaste',
  /** Text replacement / autocorrect (NOT handled) */
  INSERT_REPLACEMENT_TEXT: 'insertReplacementText',
  /** Composition commit (NOT handled – relies on Ghostty compositionend) */
  INSERT_FROM_COMPOSITION: 'insertFromComposition',
  /** Composition in progress (NOT handled – relies on Ghostty) */
  INSERT_COMPOSITION_TEXT: 'insertCompositionText',
  /** Drop event (NOT handled) */
  INSERT_FROM_DROP: 'insertFromDrop',
  /** Transpose (NOT handled) */
  INSERT_TRANSPOSE: 'insertTranspose',

  // --- Line breaks ---
  INSERT_LINE_BREAK: 'insertLineBreak',
  INSERT_PARAGRAPH: 'insertParagraph',

  // --- Deletion ---
  DELETE_CONTENT_BACKWARD: 'deleteContentBackward',
  /** Forward delete / Delete key (NOT handled) */
  DELETE_CONTENT_FORWARD: 'deleteContentForward',
  /** Cut (NOT handled) */
  DELETE_BY_CUT: 'deleteByCut',
  /** Drag removal (NOT handled) */
  DELETE_BY_DRAG: 'deleteByDrag',
  /** Word backward (swipe-delete-word on some keyboards, NOT handled) */
  DELETE_WORD_BACKWARD: 'deleteWordBackward',
  /** Word forward (NOT handled) */
  DELETE_WORD_FORWARD: 'deleteWordForward',
  /** Soft line backward (IME-specific, NOT handled) */
  DELETE_SOFT_LINE_BACKWARD: 'deleteSoftLineBackward',
  /** Soft line forward (IME-specific, NOT handled) */
  DELETE_SOFT_LINE_FORWARD: 'deleteSoftLineForward',
  /** Hard line backward (IME-specific, NOT handled) */
  DELETE_HARD_LINE_BACKWARD: 'deleteHardLineBackward',
  /** Hard line forward (IME-specific, NOT handled) */
  DELETE_HARD_LINE_FORWARD: 'deleteHardLineForward',
} as const;

describe('TerminalViewport beforeinput handler (reproduction for #2474)', () => {
  // -----------------------------------------------------------------------
  // HANDLED cases – work as intended
  // -----------------------------------------------------------------------
  test('handles insertText (direct character typing)', () => {
    expect(simulateBeforeInputHandler('insertText', 'a', false)).toBe('a');
    expect(simulateBeforeInputHandler('insertText', 'z', false)).toBe('z');
    expect(simulateBeforeInputHandler('insertText', ' ', false)).toBe(' ');
    expect(simulateBeforeInputHandler('insertText', '\n', false)).toBe('\n');
  });

  test('handles insertLineBreak / insertParagraph (Enter key)', () => {
    expect(simulateBeforeInputHandler('insertLineBreak', null, false)).toBe('\r');
    expect(simulateBeforeInputHandler('insertParagraph', null, false)).toBe('\r');
  });

  test('handles deleteContentBackward (backspace)', () => {
    expect(simulateBeforeInputHandler('deleteContentBackward', null, false)).toBe('\x7f');
  });

  // -----------------------------------------------------------------------
  // MISSING cases – silently dropped → reproduce the bugs in #2474
  // -----------------------------------------------------------------------
  test('DROPS insertFromPaste → pasting text fails', () => {
    // This is the primary cause of "pasting text fails" on OnePlus 12.
    const result = simulateBeforeInputHandler('insertFromPaste', 'pasted text', false);
    expect(result).toBeNull();
  });

  test('DROPS insertFromComposition → text lost if Ghostty compositionend fails', () => {
    // When the IME commits composition, Chrome fires
    // `beforeinput({ inputType: 'insertFromComposition', isComposing: false })`.
    // If Ghostty's internal composition handler does not reliably deliver the
    // committed text through `onData` on Android 16 WebView, the text is lost.
    const result = simulateBeforeInputHandler('insertFromComposition', 'composed', false);
    expect(result).toBeNull();
  });

  test('DROPS insertCompositionText when isComposing=true (intentional, but risky)', () => {
    // Composition updates are intentionally skipped because the comment says
    // "ghostty commits them itself on compositionend".  If Ghostty's
    // composition handling is unreliable on a given device/Android-version,
    // ALL text typed through a composing IME is lost.
    const result = simulateBeforeInputHandler('insertCompositionText', 'abc', true);
    expect(result).toBeNull();
  });

  test('DROPS insertReplacementText (autocorrect)', () => {
    // Some IMEs fire `inputType: 'insertReplacementText'` for autocorrected
    // text.  This is silently dropped.
    const result = simulateBeforeInputHandler('insertReplacementText', 'corrected', false);
    expect(result).toBeNull();
  });

  test('DROPS deleteContentForward (forward delete)', () => {
    const result = simulateBeforeInputHandler('deleteContentForward', null, false);
    expect(result).toBeNull();
  });

  test('DROPS deleteWordBackward (word-level backspace gesture)', () => {
    // Some keyboards (Gboard, Samsung) support swipe-to-delete-word gestures
    // that fire `deleteWordBackward`.  This is silently dropped.
    const result = simulateBeforeInputHandler('deleteWordBackward', null, false);
    expect(result).toBeNull();
  });

  test('DROPS deleteWordForward (word-level forward delete)', () => {
    const result = simulateBeforeInputHandler('deleteWordForward', null, false);
    expect(result).toBeNull();
  });

  test('DROPS deleteByCut (cut operation)', () => {
    const result = simulateBeforeInputHandler('deleteByCut', null, false);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // isComposing behaviour – all composing events are skipped
  // -----------------------------------------------------------------------
  test('skips insertText when isComposing=true', () => {
    const result = simulateBeforeInputHandler('insertText', 'a', true);
    expect(result).toBeNull();
  });

  test('skips deleteContentBackward when isComposing=true', () => {
    const result = simulateBeforeInputHandler('deleteContentBackward', null, true);
    expect(result).toBeNull();
  });

  test('skips insertLineBreak when isComposing=true', () => {
    const result = simulateBeforeInputHandler('insertLineBreak', null, true);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Summary – count handled vs dropped types
  // -----------------------------------------------------------------------
  test('counts handled vs unhandled input types', () => {
    const allTypes = Object.values(INPUT_TYPES);
    const results = allTypes.map((type) => {
      const data = type.startsWith('insert') ? 'x' : null;
      return { type, forwarded: simulateBeforeInputHandler(type, data, false) !== null };
    });

    const handled = results.filter((r) => r.forwarded);
    const dropped = results.filter((r) => !r.forwarded);

    // Only 4 types are handled: insertText, insertLineBreak,
    // insertParagraph, deleteContentBackward
    expect(handled).toHaveLength(4);
    // All other common types are silently dropped
    expect(dropped.length).toBeGreaterThan(0);

    console.log('── Handled inputTypes ──');
    for (const r of handled) console.log(`  ✅ ${r.type}`);
    console.log('── Dropped inputTypes ──');
    for (const r of dropped) console.log(`  ❌ ${r.type}${r.type === 'insertFromPaste' ? '  <-- pasting fails' : ''}${r.type === 'deleteWordBackward' ? '  <-- word-delete gesture' : ''}${r.type === 'insertReplacementText' ? '  <-- autocorrect' : ''}${r.type === 'insertFromComposition' ? '  <-- composition commit lost if Ghostty fails' : ''}`);
  });
});
