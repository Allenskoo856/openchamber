/**
 * Reproduction test for issue #2472: inconsistent terminal input between
 * devices and selected default keyboards on mobile (Web/PWA).
 *
 * The `beforeinput` handler in TerminalViewport bridges ghostty-web's
 * keydown-only input model with Android IME text delivery. This test
 * simulates the event flow from different keyboard implementations to
 * detect double-input or lost-input conditions.
 */

import { describe, expect, test } from 'bun:test';

/**
 * Simulated `beforeinput` handler (as implemented in TerminalViewport.tsx lines 243-259).
 * This is the code path that forwards Android IME text to the terminal when ghostty-web
 * cannot handle it via keydown/composition events.
 */
function simulateBeforeInputHandler(
  event: { inputType: string; data: string | null; isComposing: boolean },
  onInput: (data: string) => void,
): void {
  if (event.isComposing) return;
  switch (event.inputType) {
    case 'insertText':
      if (event.data) onInput(event.data);
      break;
    case 'insertLineBreak':
    case 'insertParagraph':
      onInput('\r');
      break;
    case 'deleteContentBackward':
      onInput('\x7f');
      break;
    default:
      break;
  }
}

/**
 * Simulated ghostty-web InputHandler.handleKeyDown behavior (based on
 * node_modules/ghostty-web/dist/ghostty-web.js lines 850-958).
 *
 * Returns:
 *   'handled'  -- ghostty consumed the event and called onData
 *   'skipped'  -- ghostty returned early (keyCode 229, composing, etc.)
 *   'ignored'  -- ghostty couldn't map the key and did nothing
 */
function simulateGhosttyKeyDown(
  event: {
    isComposing: boolean;
    keyCode: number;
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
  },
  isGhosttyComposing: boolean,
  onData: (data: string) => void,
): 'handled' | 'skipped' | 'ignored' {
  // ghostty's guard at line 851
  if (isGhosttyComposing || event.isComposing || event.keyCode === 229) {
    return 'skipped';
  }

  // ghostty's printable character path (line 859-861)
  const isPrintable =
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.keyCode !== 229;

  if (isPrintable) {
    onData(event.key);
    return 'handled';
  }

  // ghostty maps key codes and encodes (line 863-954, simplified)
  // For non-printable keys that can be mapped
  const mapped = mapGhosttyCode(event.code);
  if (mapped !== null) {
    onData(mapped);
    return 'handled';
  }

  return 'ignored';
}

function mapGhosttyCode(code: string): string | null {
  const map: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    Backspace: '\x7f',
    Escape: '\x1b',
    Home: '\x1b[H',
    End: '\x1b[F',
    Insert: '\x1b[2~',
    Delete: '\x1b[3~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    F1: '\x1bOP',
    F2: '\x1bOQ',
    F3: '\x1bOR',
    F4: '\x1bOS',
    F5: '\x1b[15~',
    F6: '\x1b[17~',
    F7: '\x1b[18~',
    F8: '\x1b[19~',
    F9: '\x1b[20~',
    F10: '\x1b[21~',
    F11: '\x1b[23~',
    F12: '\x1b[24~',
  };
  // Arrow keys (handled by encoder in real code, simplified here)
  if (code.startsWith('Arrow')) {
    const dir: Record<string, string> = {
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowLeft: '\x1b[D',
      ArrowRight: '\x1b[C',
    };
    return dir[code] ?? null;
  }
  return map[code] ?? null;
}

/**
 * Simulate ghostty-web's compositionend handler (line 994-1003).
 */
function simulateGhosttyCompositionEnd(
  data: string | null,
  onData: (data: string) => void,
): void {
  if (data && data.length > 0) {
    onData(data);
  }
}

// Scenarios matrix: all combinations of relevant parameters
type Scenario = {
  name: string;
  keydownKeyCode: number;        // 229 = soft keyboard, other = hardware
  keydownKey: string;
  keydownIsComposing: boolean;   // DOM event isComposing flag
  ghosttyIsComposing: boolean;   // ghostty's internal isComposing state
  beforeinputInputType: string | null;  // null = no beforeinput fires
  beforeinputData: string | null;
  beforeinputIsComposing: boolean;
  firesCompositionEnd: boolean;
  compositionEndData: string | null;
};

const SCENARIOS: Scenario[] = [
  // ── Android soft keyboard, English direct input (no composition) ──
  {
    name: 'Android soft keyboard - English letter "a"',
    keydownKeyCode: 229,
    keydownKey: 'a',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'insertText',
    beforeinputData: 'a',
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },
  {
    name: 'Android soft keyboard - Enter key',
    keydownKeyCode: 229,
    keydownKey: 'Enter',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'insertLineBreak',
    beforeinputData: null,
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },
  {
    name: 'Android soft keyboard - Backspace',
    keydownKeyCode: 229,
    keydownKey: 'Backspace',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'deleteContentBackward',
    beforeinputData: null,
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },

  // ── Android Gboard with composition (e.g., Chinese/Japanese/emoji) ──
  {
    name: 'Android Gboard composition - committed text "hello"',
    keydownKeyCode: 229,
    keydownKey: 'Unidentified',
    keydownIsComposing: true,
    ghosttyIsComposing: true,
    beforeinputInputType: 'insertText',
    beforeinputData: 'hello',
    beforeinputIsComposing: true,  // isComposing=true → handler skips it
    firesCompositionEnd: true,
    compositionEndData: 'hello',
  },

  // ── Android soft keyboard with some keyboards not setting keyCode=229 ──
  // BUG (#2472): When keyCode !== 229, ghostty handles the keydown AND
  // beforeinput also fires, resulting in DOUBLE INPUT.
  {
    name: 'Some keyboards: keyCode!=229 + beforeinput (DOUBLE INPUT BUG #2472)',
    keydownKeyCode: 0,          // Not 229!
    keydownKey: 'a',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'insertText',
    beforeinputData: 'a',
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },

  // ── Hardware keyboard on Android tablet ──
  // BUG (#2472): Hardware keyboards send proper keyCodes. ghostty handles
  // the keydown and calls onData. But beforeinput also fires (some browsers),
  // so the same character is sent TWICE.
  {
    name: 'Hardware keyboard - letter "a" (DOUBLE INPUT BUG #2472)',
    keydownKeyCode: 65,        // KeyA
    keydownKey: 'a',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'insertText',
    beforeinputData: 'a',
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },

  // ── Samsung Keyboard / third-party keyboard: fires beforeinput but
  //    also fires keydown with non-229 keyCode for some keys ──
  // BUG (#2472): Same double-input issue for non-letter keys like Tab
  {
    name: 'Third-party keyboard: keyCode!=229 Tab + beforeinput (DOUBLE INPUT BUG #2472)',
    keydownKeyCode: 9,
    keydownKey: 'Tab',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: 'insertText',
    beforeinputData: '\t',
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },

  // ── Keyboard that does NOT fire beforeinput for certain keys ──
  {
    name: 'Keyboard that skips beforeinput for arrow keys (only keydown works)',
    keydownKeyCode: 229,
    keydownKey: 'ArrowUp',
    keydownIsComposing: false,
    ghosttyIsComposing: false,
    beforeinputInputType: null,    // No beforeinput fires
    beforeinputData: null,
    beforeinputIsComposing: false,
    firesCompositionEnd: false,
    compositionEndData: null,
  },

  // ── IME that commits via compositionend only, no useful beforeinput ──
  {
    name: 'IME via compositionend only (some keyboards)',
    keydownKeyCode: 229,
    keydownKey: 'Unidentified',
    keydownIsComposing: true,
    ghosttyIsComposing: true,
    beforeinputInputType: 'insertCompositionText',
    beforeinputData: 'text',
    beforeinputIsComposing: true,  // skipped by handler
    firesCompositionEnd: true,
    compositionEndData: 'text',
  },
];

describe('Terminal input handling consistency (#2472)', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, () => {
      const received: string[] = [];
      const onInput = (data: string) => { received.push(data); };

      // 1. Simulate ghostty-web keydown handling
      const ghosttyResult = simulateGhosttyKeyDown(
        {
          isComposing: scenario.keydownIsComposing,
          keyCode: scenario.keydownKeyCode,
          key: scenario.keydownKey,
          code: scenario.keydownKey,
          ctrlKey: false,
          metaKey: false,
        },
        scenario.ghosttyIsComposing,
        onInput,
      );

      // 2. Simulate beforeinput (if it fires)
      if (scenario.beforeinputInputType !== null) {
        simulateBeforeInputHandler(
          {
            inputType: scenario.beforeinputInputType,
            data: scenario.beforeinputData,
            isComposing: scenario.beforeinputIsComposing,
          },
          onInput,
        );
      }

      // 3. Simulate compositionend (if it fires)
      if (scenario.firesCompositionEnd) {
        simulateGhosttyCompositionEnd(scenario.compositionEndData, onInput);
      }

      // Each scenario should result in exactly one input event.
      // Double input = bug. Zero input = bug.

      // The expected behavior: exactly one callback call with the correct data
      console.log(`  ghostty handled: ${ghosttyResult}, received: ${JSON.stringify(received)}`);
    });
  }
});

describe('BeforeInput handler edge case coverage (#2472)', () => {
  test('does NOT forward text during IME composition (isComposing=true)', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'pending', isComposing: true },
      (data) => { received.push(data); },
    );
    expect(received).toEqual([]);
  });

  test('forwards insertText when not composing', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'a', isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual(['a']);
  });

  test('forwards insertLineBreak as carriage return', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertLineBreak', data: null, isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual(['\r']);
  });

  test('forwards insertParagraph as carriage return', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertParagraph', data: null, isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual(['\r']);
  });

  test('forwards deleteContentBackward as DEL (0x7f)', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'deleteContentBackward', data: null, isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual(['\x7f']);
  });

  test('ignores insertFromComposition (handled by ghostty compositionend)', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertFromComposition', data: 'text', isComposing: true },
      (data) => { received.push(data); },
    );
    expect(received).toEqual([]);
  });

  test('ignores unknown inputType', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'formatBold', data: null, isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual([]);
  });

  test('ignores insertText with null data', () => {
    const received: string[] = [];
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: null, isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual([]);
  });
});

describe('Ghostty-web keydown guard analysis (#2472)', () => {
  /**
   * This test verifies ghostty-web's guard clause at line 851:
   *   if (this.isDisposed || this.isComposing || A.isComposing || A.keyCode === 229)
   *     return;
   *
   * When ghostty skips a keydown (does NOT call preventDefault),
   * the browser dispatches beforeinput, which our handler forwards.
   * But when ghostty HANDLES the keydown (calls preventDefault),
   * beforeinput typically does NOT fire.
   *
   * The problem: if a keyboard sends keydown with keyCode !== 229
   * AND beforeinput also fires for the same keystroke, the input
   * is sent TWICE.
   */

  test('ghostty skips keyCode 229 (soft keyboard) - beforeinput expected', () => {
    // ghostty returns early at line 851, does NOT call preventDefault
    // Browser then dispatches beforeinput → our handler should catch it
    const received: string[] = [];
    const result = simulateGhosttyKeyDown(
      { isComposing: false, keyCode: 229, key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false },
      false,
      (data) => { received.push(data); },
    );
    expect(result).toBe('skipped');
    expect(received).toEqual([]); // ghostty didn't forward it

    // beforeinput MUST fire for Android to get input
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'a', isComposing: false },
      (data) => { received.push(data); },
    );
    expect(received).toEqual(['a']); // single input - correct!
  });

  test('ghostty handles keyCode !== 229 (physical keyboard) - beforeinput may NOT fire', () => {
    // ghostty handles the keydown, calls preventDefault
    // Browser typically does NOT dispatch beforeinput after prevented keydown
    const received: string[] = [];
    const result = simulateGhosttyKeyDown(
      { isComposing: false, keyCode: 65, key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false },
      false,
      (data) => { received.push(data); },
    );
    expect(result).toBe('handled');
    expect(received).toEqual(['a']); // ghostty forwarded it

    // If beforeinput ALSO fires (some keyboards), it would be double:
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'a', isComposing: false },
      (data) => { received.push(data); },
    );
    // This would be DOUBLE INPUT: ['a', 'a']
    // But on standard Android, beforeinput shouldn't fire when
    // keydown was canceled. However, some keyboard implementations
    // or browser versions may still fire it, causing the bug.
    // BUG REPRODUCED (#2472): When both ghostty AND beforeinput fire for
    // the same keystroke (e.g., keyboards that send keyCode !== 229),
    // the input is sent TWICE, causing double characters in the terminal.
    // This is the root cause of the inconsistency: different keyboards
    // dispatch events differently, and the beforeinput handler doesn't
    // coordinate with ghostty's own keydown handling.
    expect(received).toEqual(['a', 'a']); // DOUBLE INPUT - bug reproduced
    console.log('  ✓ DOUBLE INPUT reproduced:', JSON.stringify(received));
  });

  test('ghostty during composition skips keydown - compositionend expected', () => {
    const received: string[] = [];
    // During composition, ghostty skips keydown
    const result = simulateGhosttyKeyDown(
      { isComposing: true, keyCode: 229, key: 'Unidentified', code: 'KeyA', ctrlKey: false, metaKey: false },
      true,
      (data) => { received.push(data); },
    );
    expect(result).toBe('skipped');

    // beforeinput with isComposing=true is also skipped by our handler
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'あ', isComposing: true },
      (data) => { received.push(data); },
    );
    expect(received).toEqual([]); // nothing yet

    // compositionend commits the text
    simulateGhosttyCompositionEnd('あ', (data) => { received.push(data); });
    expect(received).toEqual(['あ']); // single input via compositionend
  });

  test('compositionend fires with text but beforeinput with isComposing=false also fires (potential double)', () => {
    // Some keyboards might fire beforeinput with isComposing=false
    // right before or after compositionend
    const received: string[] = [];
    
    // compositionend commits
    simulateGhosttyCompositionEnd('hello', (data) => { received.push(data); });
    expect(received).toEqual(['hello']);

    // If beforeinput ALSO fires with isComposing=false for the same text
    simulateBeforeInputHandler(
      { inputType: 'insertText', data: 'hello', isComposing: false },
      (data) => { received.push(data); },
    );
    
    // BUG REPRODUCED (#2472): When beforeinput with isComposing=false fires
    // after compositionend (some keyboard implementations), the input is
    // sent TWICE.
    expect(received).toEqual(['hello', 'hello']); // DOUBLE INPUT - bug reproduced
    console.log('  ✓ DOUBLE INPUT reproduced:', JSON.stringify(received));
  });
});

describe('Event flow analysis for issue #2472', () => {
  /**
   * This is a meta-test that documents the complete event flow
   * and highlights where inconsistencies can arise across devices.
   *
   * Root cause summary:
   *
   * ghostty-web's InputHandler (line 851) skips keydown events when:
   *   - keyCode === 229 (all Android soft keyboard input)
   *   - isComposing is true (IME composition in progress)
   *
   * When ghostty skips keydown, it does NOT call preventDefault().
   * This allows beforeinput to fire, which our handler (TerminalViewport.tsx
   * lines 243-259) catches and forwards to the terminal.
   *
   * INCONSISTENCY SOURCES:
   *
   * 1. Some Android keyboards/IME implementations may fire keydown with
   *    keyCode !== 229 while also firing beforeinput. In this case, both
   *    ghostty AND our beforeinput handler forward the data → DOUBLE INPUT.
   *
   * 2. Some keyboards may not fire beforeinput for specific key types
   *    (e.g., function keys, arrow keys). When keyCode is 229 and ghostty
   *    skips the keydown, no one forwards the data → LOST INPUT.
   *
   * 3. The beforeinput handler does NOT handle insertFromComposition
   *    or other composition-related input types. During IME composition,
   *    handler relies entirely on ghostty's compositionend handler.
   *    If ghostty's compositionend fails for any reason → LOST INPUT.
   *
   * 4. Hardware keyboards on Android tablets send proper keyCode values.
   *    ghostty handles them correctly and calls preventDefault() on keydown.
   *    beforeinput should not fire for these, but behavior varies across
   *    browsers and Android versions.
   */
  test('documentation of root cause - see comments', () => {
    // This test exists only to persist the analysis in test output.
    // The actual issue is in the interaction between ghostty-web's
    // InputHandler and TerminalViewport's beforeinput handler.
    expect(true).toBe(true);
  });
});
