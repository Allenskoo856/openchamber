/**
 * Reproduction for issue #2503: ctrl+2 opens "changes" pane with no way to rebind it.
 *
 * This test demonstrates two problems:
 *   1. `mod+2` triggers `open_diff_panel`, which opens the changes/diff panel.
 *      This hijacks the browser's native Cmd+2 / Ctrl+2 shortcut for switching tabs.
 *   2. The `open_diff_panel` action is NOT marked as `customizable`, so it does
 *      NOT appear in the Keyboard Shortcuts settings UI. Users cannot rebind or
 *      disable it through the settings interface.
 */
import { describe, expect, test } from 'bun:test';

import {
  getShortcutAction,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
} from './shortcuts';

describe('Bug reproduction: ctrl+2 opens "changes" pane (issue #2503)', () => {
  test('open_diff_panel exists and is bound to mod+2', () => {
    const action = getShortcutAction('open_diff_panel');
    expect(action).toBeDefined();
    expect(action!.defaultCombo).toBe('mod+2');
  });

  test('open_diff_panel is NOT customizable — cannot be unbound via settings UI', () => {
    const action = getShortcutAction('open_diff_panel')!;
    // The `customizable` property is optional and defaults to undefined.
    // When it is not explicitly set to `true`, the action does NOT appear in
    // the KeyboardShortcutsSettings panel (see `getCustomizableShortcutActions`).
    expect(action.customizable).not.toBe(true);

    // Confirm that getCustomizableShortcutActions excludes it.
    const customizableActions = getCustomizableShortcutActions();
    const customizableIds = customizableActions.map((a) => a.id);
    expect(customizableIds).not.toContain('open_diff_panel');
  });

  test('shortcut overrides for open_diff_panel are theoretically supported, but inaccessible', () => {
    // The keyboard handler in `useKeyboardShortcuts.ts` calls:
    //   eventMatchesShortcut(e, combo('open_diff_panel'))
    // where `combo` resolves to `getEffectiveShortcutCombo('open_diff_panel', overrides)`.
    //
    // Even though `getEffectiveShortcutCombo` checks overrides, the
    // KeyboardShortcutsSettings UI never lets the user set an override for
    // `open_diff_panel` because it is not customizable. So in practice there
    // is no user-facing way to change or disable this shortcut.
    //
    // Verify the override mechanism works in theory but is inaccessible to users:
    const defaultCombo = getEffectiveShortcutCombo('open_diff_panel', {});
    expect(defaultCombo).toBe('mod+2');

    // With a hypothetical override, the shortcut could be unassigned.
    // But users cannot set this override because the settings UI does
    // not expose this action.
    const unassignedCombo = getEffectiveShortcutCombo('open_diff_panel', {
      open_diff_panel: '__unassigned__',
    });
    expect(unassignedCombo).toBe('');
  });

  test('switch_tab_2 also uses mod+2 and is also NOT customizable', () => {
    // There is also a `switch_tab_2` action with `mod+2` in shortcuts.ts.
    // It too is non-customizable. This means there are TWO hard-coded
    // `mod+2` bindings that users cannot disable or rebind.
    const action = getShortcutAction('switch_tab_2');
    expect(action).toBeDefined();
    expect(action!.defaultCombo).toBe('mod+2');
    expect(action!.customizable).not.toBe(true);
  });

  test('KeyboardShortcutsSettings only renders customizable actions — open_diff_panel is absent', () => {
    // The KeyboardShortcutsSettings component (line 61) uses:
    //   const all = getCustomizableShortcutActions();
    // This filters to actions with `customizable === true`.
    //
    // Since `open_diff_panel` is not customizable, it never renders in the
    // settings UI, so the user cannot change or disable the `mod+2` binding.
    const displayable = getCustomizableShortcutActions();
    for (const action of displayable) {
      expect(action.customizable).toBe(true);
    }
  });
});
