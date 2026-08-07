// Reproduction for https://github.com/openchamber/openchamber/issues/2745
//
// "[Bug] Language setting issue" — after exiting and reopening OpenChamber,
// the UI language reverts to English and the "Add project directory" prompt
// pops up again even though projects were already added.
//
// Root cause (both symptoms):
//   1. The language/locale preference is persisted ONLY to window.localStorage
//      under `openchamber.i18n.v1` (`writeStoredLocale` in
//      lib/i18n/runtime.ts). It is never written to the shared settings file
//      (`~/.config/openchamber/settings.json`) — there is no `locale` field on
//      DesktopSettings, and the server settings path
//      (packages/web/server/lib/opencode/settings-runtime.js) has zero
//      references to locale/i18n. Whenever localStorage is unavailable/lost on
//      restart, `detectInitialLocale()` silently falls back to `'en'`.
//   2. The projects cache lives in localStorage too (namespaced
//      `projects:<apiBaseUrl>` keys, read synchronously at module load). When
//      that cache is gone, `useProjectsStore` boots with `projects: []`, which
//      is exactly the condition that makes the SessionDialogs effect open the
//      "Add project directory" dialog (`projects.length > 0` guard). The
//      authoritative project list in settings.json is only restored
//      asynchronously later via `syncDesktopSettings` →
//      `synchronizeFromSettings`, i.e. after the dialog has already fired.
//      Worse, a settings sync whose payload omits `projects` actively REMOVES
//      the localStorage `'projects'` key (`persistToLocalStorage`) and clears
//      the in-memory store (`synchronizeFromSettings`), so the prompt keeps
//      reappearing on every subsequent launch.

import { afterAll, describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Environment setup: create window + localStorage BEFORE the UI modules load,
// exactly like a real browser, so module-level wiring (e.g. the store's
// `openchamber:settings-synced` listener) attaches.
// ---------------------------------------------------------------------------
const values = new Map<string, string>();

const storageLike = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => { values.clear(); },
};

const eventTarget = new EventTarget();
const testWindow = {
  localStorage: storageLike,
  location: { search: '', href: 'http://127.0.0.1:6069/', origin: 'http://127.0.0.1:6069' },
  addEventListener: eventTarget.addEventListener.bind(eventTarget),
  removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
  dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
} as unknown as typeof window & { localStorage: Storage };

Object.defineProperty(globalThis, 'window', { value: testWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: storageLike, configurable: true, writable: true });

// Mirror the desktop preload-injected local origin (loopback UI + API server).
Object.defineProperty(testWindow, '__OPENCHAMBER_LOCAL_ORIGIN__', {
  value: 'http://127.0.0.1:6069',
  configurable: true,
  writable: true,
});

// ---------------------------------------------------------------------------
// Now load the real modules. useDirectoryStore performs module-level probe
// calls against the (non-existent) loopback server at import time; those
// connection-refused warnings are unrelated to the reproduction and are
// suppressed so the test output stays readable.
// ---------------------------------------------------------------------------
const suppressedPrefixes = [
  'Failed to resolve filesystem home directory',
  'Failed to load path info',
  'Failed to load project info',
  'Failed to inspect sessions for system info',
];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (suppressedPrefixes.some((prefix) => first.startsWith(prefix))) return;
  originalWarn(...args);
};

const [
  { registerRuntimeAPIs },
  { LOCALE_STORAGE_KEY, detectInitialLocale, writeStoredLocale },
  { useI18nStore },
  { syncDesktopSettings, invalidateSettingsCache },
  { switchRuntimeEndpoint },
  { getDeferredSafeStorage },
  { useProjectsStore },
  { createProjectIdFromPath },
] = await Promise.all([
  import('@/contexts/runtimeAPIRegistry'),
  import('@/lib/i18n/runtime'),
  import('@/lib/i18n/store'),
  import('@/lib/persistence'),
  import('@/lib/runtime-switch'),
  import('@/stores/utils/safeStorage'),
  import('@/stores/useProjectsStore'),
  import('@/lib/projectId'),
]);

type SettingsPayload = { themeId?: string; projects?: unknown; activeProjectId?: string };

const registerSettingsApi = (
  load: () => Promise<{ settings: SettingsPayload; source: 'web' | 'vscode' }>,
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>,
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load, save },
  } as never);
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const samplePath = '/Users/example/my-project';
const sampleProject = {
  id: 'proj_1',
  path: samplePath,
  label: 'My Project',
  addedAt: 1,
  lastOpenedAt: 1,
};

// The store recomputes project IDs from the path on restore
// (`synchronizeFromSettings` → `sanitizeProjects` → `createProjectIdFromPath`).
const restoredProjectId = createProjectIdFromPath(samplePath);

// Bind the renderer to a stable local runtime so the projects storage
// namespace is deterministic (mirrors the desktop loopback server origin).
switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:6069', runtimeKey: 'local' });

// In a real browser `window` exists before the UI modules evaluate, so
// useProjectsStore.ts attaches its `openchamber:settings-synced` listener at
// module load. When this test file is loaded in a shared process where another
// test file already evaluated the store in a windowless context, that wiring
// was skipped — re-attach it here (identical to the module's own wiring) so
// the reproduction is deterministic regardless of run mode.
window.addEventListener('openchamber:settings-synced', ((event: Event) => {
  const detail = (event as CustomEvent<{ projects?: unknown; activeProjectId?: string }>).detail;
  if (detail && typeof detail === 'object') {
    useProjectsStore.getState().synchronizeFromSettings(detail as never);
  }
}) as EventListener);

console.warn = originalWarn;

afterAll(() => {
  registerRuntimeAPIs(null);
});

describe('issue-2745: language resets to English when localStorage is lost', () => {
  test('locale is stored ONLY in localStorage and silently falls back to "en"', () => {
    invalidateSettingsCache();
    // Session 1: user picks a language.
    writeStoredLocale('zh-CN');
    expect(values.get(LOCALE_STORAGE_KEY)).toBe(JSON.stringify({ locale: 'zh-CN' }));
    expect(detectInitialLocale()).toBe('zh-CN');

    // The DesktopSettings / settings.json persistence layer never touches the
    // locale — a settings sync writes no locale key to localStorage at all.
    const syncDone = deferred<void>();
    registerSettingsApi(
      async () => ({ settings: { themeId: 'dark' }, source: 'web' }),
      async () => ({ themeId: 'dark' }),
    );
    void syncDesktopSettings().then(() => syncDone.resolve());
    void syncDone.promise;

    // Restart simulation: the renderer storage (localStorage partition) is
    // gone. The app has no other copy of the locale.
    values.delete(LOCALE_STORAGE_KEY);
    expect(detectInitialLocale()).toBe('en');

    // initializeLocale() with the cleared storage boots the store as English.
    useI18nStore.setState({ locale: 'zh-CN' });
    useI18nStore.getState().setLocale(detectInitialLocale());
    expect(useI18nStore.getState().locale).toBe('en');
  });
});

describe('issue-2745: "Add project directory" prompt reappears after restart', () => {
  test('with a lost localStorage cache the projects store boots empty — the prompt trigger — even though settings.json still holds the projects', async () => {
    invalidateSettingsCache();
    // Restart with the localStorage partition lost (exactly what the reporter
    // describes): the store seeds from an empty cache.
    values.clear();
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });

    // This is the guard evaluated by the SessionDialogs effect
    // (packages/ui/src/components/session/SessionDialogs.tsx):
    //   if (hasShownInitialDirectoryPrompt || !isHomeReady || projects.length > 0) return;
    //   setIsDirectoryDialogOpen(true);
    // → with projects.length === 0 the "Add project directory" dialog opens.
    expect(useProjectsStore.getState().projects.length === 0).toBe(true);

    // The authoritative project list still exists server-side (settings.json)
    // and is only restored asynchronously via syncDesktopSettings →
    // synchronizeFromSettings — i.e. AFTER the dialog has already been
    // triggered on mount.
    const syncDone = deferred<void>();
    registerSettingsApi(
      async () => ({ settings: { projects: [sampleProject], activeProjectId: sampleProject.id }, source: 'web' }),
      async () => ({ projects: [sampleProject], activeProjectId: sampleProject.id }),
    );
    void syncDesktopSettings().then(() => syncDone.resolve());
    await syncDone.promise;

    // Wait for the settings fetch + store synchronization to settle.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (useProjectsStore.getState().projects.length > 0) break;
      await delay(10);
    }

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([restoredProjectId]);
  });

  test('a settings sync whose payload omits projects wipes the localStorage cache and the store — the prompt then reappears on every launch', async () => {
    invalidateSettingsCache();
    // Re-seed the cache as a healthy session would leave it.
    const restoredProject = { ...sampleProject, id: restoredProjectId };
    useProjectsStore.setState({
      projects: [restoredProject],
      activeProjectId: restoredProjectId,
      manualProjectOrder: [restoredProjectId],
    });
    const storage = getDeferredSafeStorage();
    storage.setItem('projects', JSON.stringify([restoredProject]));
    storage.setItem('activeProjectId', restoredProjectId);
    // Give the deferred storage a tick to flush to the underlying map.
    await delay(0);

    expect(values.has('projects')).toBe(true);

    // Server responds with a settings payload that does NOT include projects
    // (e.g. a boot-time read of a settings file that lacks the key, a
    // migration write race, or a partial payload). syncDesktopSettings then:
    //   persistToLocalStorage(settings) → localStorage.removeItem('projects')
    //   dispatchSettingsSynced → synchronizeFromSettings → store cleared.
    const syncDone = deferred<void>();
    registerSettingsApi(
      async () => ({ settings: { themeId: 'dark' }, source: 'web' }),
      async () => ({ themeId: 'dark' }),
    );
    void syncDesktopSettings().then(() => syncDone.resolve());
    await syncDone.promise;
    await delay(0);

    // The localStorage projects cache has been actively removed…
    expect(values.has('projects')).toBe(false);
    // …and the in-memory store is empty again.
    expect(useProjectsStore.getState().projects).toEqual([]);

    // Next boot therefore starts with projects.length === 0 again and the
    // "Add project directory" dialog pops up once more.
    expect(useProjectsStore.getState().projects.length === 0).toBe(true);
  });
});
