# Reproduction: Language setting resets to English and "Add project directory" reappears (#2745)

Reproduces https://github.com/openchamber/openchamber/issues/2745 using the real
UI modules (`i18n` runtime/store, `useProjectsStore`, `persistence.ts`) — no
mocks.

## Run

```sh
bun test src/repro/issue-2745.test.ts
# from packages/ui
```

## What it demonstrates

Both reported symptoms share one root cause: the two pieces of state the user
loses on restart live **only** in `window.localStorage`, and there is no
fallback to the shared settings file (`~/.config/openchamber/settings.json`).

1. **Language resets to English.** The locale is persisted exclusively via
   `writeStoredLocale()` → `localStorage['openchamber.i18n.v1']`
   (`packages/ui/src/lib/i18n/runtime.ts`). It is never written to
   `DesktopSettings`/settings.json — the server settings path
   (`packages/web/server/lib/opencode/settings-runtime.js`) has zero references
   to locale/i18n. The test writes `zh-CN`, then simulates the reported restart
   with the renderer storage gone: `detectInitialLocale()` and
   `initializeLocale()` silently fall back to `'en'`.

2. **"Add project directory" pops up again.** The projects cache is also
   localStorage-only at boot (`projects:<apiBaseUrl>` keys, read synchronously
   when `useProjectsStore` initializes). The `SessionDialogs` effect opens the
   dialog whenever `projects.length === 0` at mount
   (`packages/ui/src/components/session/SessionDialogs.tsx`, guard
   `hasShownInitialDirectoryPrompt || !isHomeReady || projects.length > 0`).
   The authoritative list in settings.json is restored only asynchronously via
   `syncDesktopSettings` → `synchronizeFromSettings` — i.e. after the dialog has
   already been triggered. Worse, a settings sync whose payload omits `projects`
   actively **removes** the `localStorage['projects']` key
   (`persistToLocalStorage`) and clears the store (`synchronizeFromSettings`),
   so the prompt keeps reappearing on every subsequent launch.

## Test cases

- `locale is stored ONLY in localStorage and silently falls back to "en"` —
  sets `zh-CN`, confirms the write, deletes the key, confirms English.
- `with a lost localStorage cache the projects store boots empty …` — boots the
  store with an empty cache (the prompt trigger), then shows the server-side
  projects only get restored asynchronously.
- `a settings sync whose payload omits projects wipes the localStorage cache
  and the store …` — a sync without a `projects` field erases the cache and the
  in-memory list, guaranteeing the prompt reappears on the next launch.

## Related

Same root cause (locale only in localStorage, never in settings.json) was
reproduced for the VS Code runtime in #2174.
