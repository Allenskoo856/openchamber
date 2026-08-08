# Reproduction: black window at startup (issue #2762)

Platform-independent mechanism reproduction for
https://github.com/openchamber/openchamber/issues/2762
"[Bug] Application window briefly shows black background before rendering UI"
(Windows 11, OpenChamber 1.18.1).

## Root cause (code path)

`packages/electron/main.mjs`:

1. `createBrowserWindow()` creates the main window with `show: false` and
   `backgroundColor: useVibrancy ? '#00000000' : '#151313'` (lines 2361-2362).
   On Windows/Linux `useVibrancy` is false, so the window's background color is
   `#151313` — a near-black color.

2. `activateMainWindow()` (lines 2636-2643) shows the window like this:

   ```js
   if (mainWindow && !mainWindow.isDestroyed()) {
     ...
     await navigateWindow(mainWindow, url, { allowAbort: true }); // resolves on did-finish-load
     mainWindow.show();   // <- shown BEFORE the renderer's first paint
     mainWindow.focus();
   ```

   `navigateWindow()` awaits `loadURL()`, which resolves on `did-finish-load`,
   not on first paint. When the splash navigation was aborted before its first
   paint (fast `resolveInitialUrl()` on a cold start), `ready-to-show` never
   fired, and this `mainWindow.show()` is the only show. If the real UI's
   renderer has not committed a frame yet, the compositor has nothing to
   display and the window shows its `backgroundColor` (`#151313`, near-black)
   until the UI's first paint — the reported black window.

## Deterministic reproduction

`black-window-repro.mjs` is a standalone Electron main script that:

- creates a `BrowserWindow` with the exact non-darwin options from
  `createBrowserWindow()` (`show:false`, `backgroundColor:'#151313'`,
  frameless, hidden title bar);
- replicates the `activateMainWindow()` show-after-load pattern
  (`await loadURL(...)` then `show()`);
- loads a page whose first paint is deliberately postponed (a busy-wait in the
  renderer) so the show-before-paint window is observable.

Run (Linux CI / any machine with Electron + xvfb):

```sh
cd packages/electron
REPRO_MODE=show-after-load REPRO_PAINT_DELAY_MS=4000 \
  xvfb-run -a -s "-screen 0 1280x800x24" \
  ./node_modules/.bin/electron --no-sandbox \
  /path/to/repro/black-window-repro.mjs
```

### Observed result (see `evidence-output.txt` and `black-frames/`)

```
[repro] t+144ms loadURL resolved -> show() (renderer has not painted yet)
[repro] screen capture t147ms: saved 0000-screen-t147ms.png
[repro] capture failed (t147ms): UnknownVizError
[repro] t+147ms capture=FAILED (no frame -> window shows backgroundColor) paintedAt=4142
[repro] t+4449ms capture=0002-t4449ms.png paintedAt=4142   <- painted, capture works
[repro] t+13053ms capture=0007-after-paint.png paintedAt=4142
```

At `show()` time (`t+144ms`) the renderer had not painted
(`paintedAt=4142`). `webContents.capturePage()` fails with
`UnknownVizError` during that interval — the compositor has no surface frame,
so the visible window can only display its `backgroundColor #151313`
(near-black). Captures succeed only after the paint, ~4 s later. This is the
black-window-then-content sequence reported in the issue.

Notes:

- On Windows (DWM) the no-frame window is painted with the `backgroundColor`,
  which is what the reporter saw as a black window. On the X11/Xvfb host used
  here the window simply has no presented frame, which is why a screenshot at
  that moment shows the root background while `capturePage()` reports
  `UnknownVizError` — same underlying state.
- The alternate startup path (splash paints before the real-UI navigation,
  `REPRO_MODE=full`) shows the splash and keeps it visible until the UI
  paints; no black window there. The black window is specific to the
  show-before-paint path.

## Real-app verification

`launch-app.sh` runs the real app under xvfb with CDP debugging
(`--remote-debugging-port=9222`); `startup-frames.mjs` + `analyze-frames.mjs`
capture/classify composited frames during startup (needs the web UI on Vite
and the API server; `vite.config.repro.mjs` adds a `/health` route the app
probes). These confirmed the splash-stays-visible path and that the window is
shown before content paints on fast startups (the first captured frame at
~300 ms already showed the UI, i.e. the window became visible without showing
the splash in the abort path).
