import { afterEach, describe, expect, test } from 'bun:test';
import { useTerminalStore } from './useTerminalStore';

/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2718
 *
 * Default terminal names are derived from the live count of open tabs
 * (`(existing?.tabs.length ?? 0) + 1` in `createTab`), not from a
 * monotonically increasing counter. Closing a tab shrinks the count, so the
 * next created tab reuses a number that is already in use.
 */
describe('issue 2718: terminal names are not unique', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  test('reuses the name of a closed terminal for a new one', () => {
    useTerminalStore.getState().clearAll();

    // First terminal (default label "Terminal").
    useTerminalStore.getState().ensureDirectory('/repo');
    const first = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0];

    // Second terminal -> "Terminal 2".
    const secondId = useTerminalStore.getState().createTab('/repo');
    const second = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((t) => t.id === secondId)!;

    expect(first.label).toBe('Terminal');
    expect(second.label).toBe('Terminal 2');

    // Close the first terminal, leaving only "Terminal 2".
    useTerminalStore.getState().closeTab('/repo', first.id);
    const remaining = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(remaining.tabs.map((t) => t.label)).toEqual(['Terminal 2']);

    // Open a new terminal. A sensible default would be "Terminal 3",
    // but it is named "Terminal 2" again (duplicate).
    const thirdId = useTerminalStore.getState().createTab('/repo');
    const third = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((t) => t.id === thirdId)!;

    expect(third.label).toBe('Terminal 3');
  });
});
