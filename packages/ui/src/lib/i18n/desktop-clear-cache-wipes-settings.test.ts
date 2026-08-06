import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectInitialLocale, LOCALE_STORAGE_KEY, writeStoredLocale } from './runtime';

// Minimal browser-like localStorage, standing in for the renderer storage that
// Electron's default session backs with on-disk storage.
class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindow = globalThis.window;
let storage: MemoryStorage;

// Faithful stand-in for the desktop "Clear Cache" action:
//   packages/electron/main.mjs -> handleInvoke(null, 'desktop_clear_cache')
//   -> await session.defaultSession.clearStorageData()
// `clearStorageData()` with no options clears ALL web storage types for the
// default session — including `localstorage`, which is where the renderer
// keeps its settings (locale, theme, appearance preferences, todos, ...).
const clearStorageData = () => storage.clear();

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('issue #2717 — desktop "Clear Cache" wipes the chosen language', () => {
  test('the language choice lives only in localStorage', () => {
    writeStoredLocale('zh-CN');

    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe(JSON.stringify({ locale: 'zh-CN' }));
    expect(detectInitialLocale()).toBe('zh-CN');
  });

  test('after Clear Cache (clearStorageData) the language falls back to English', () => {
    // User switches the UI to Chinese in Settings.
    writeStoredLocale('zh-CN');
    expect(detectInitialLocale()).toBe('zh-CN');

    // Desktop: Help -> "Clear Cache" -> desktop_clear_cache -> clearStorageData().
    clearStorageData();

    // Reproduced: the setting is wiped, so the next bootstrap reports 'en'.
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(detectInitialLocale()).toBe('en');
  });

  test('the language is not restored from server-side settings after the wipe', () => {
    // DesktopSettings (packages/ui/src/lib/desktop.ts) has no `locale` field and
    // the server settings payload does not carry it, so nothing re-applies it.
    writeStoredLocale('fr');
    clearStorageData();

    expect(detectInitialLocale()).toBe('en');
  });
});
