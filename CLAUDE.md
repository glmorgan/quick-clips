# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # One-time build → com.quickclips.streamdeck.sdPlugin/bin/plugin.js
npm run watch        # Build + watch; auto-restarts plugin on save via `streamdeck restart`
npm test             # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
npx streamdeck dev   # Enable developer mode (required once per machine for streamdeck restart and plugin logging)
npm run build:native # Build the native picker window host (Swift; needs Command Line Tools)
npm run release      # test → build → build:native → pack → verify. Use this to cut a release.
npm run verify       # Validate an already-packed .streamDeckPlugin
npx streamdeck pack com.quickclips.streamdeck.sdPlugin --force  # Create distributable .streamDeckPlugin file
tail -f com.quickclips.streamdeck.sdPlugin/logs/com.quickclips.streamdeck.0.log  # Plugin logs
```

Tests cover pure functions in `src/utils.ts` only. Manual testing requires the Stream Deck app running with the plugin symlinked (see README). Developer mode must be enabled once per machine for `npm run watch` auto-restart to work.

## Architecture

This is an Elgato Stream Deck plugin built with the `@elgato/streamdeck` SDK v2. The plugin runs as a Node.js process that communicates with the Stream Deck app over WebSocket.

**Entry point:** `src/plugin.ts` — registers both actions, calls `streamDeck.connect()`, and sets `process.chdir()` to the sdPlugin directory so the SDK can find `manifest.json` when relaunched via `streamdeck restart` (which otherwise sets CWD to the repo root via symlink resolution).

**Build output:** Rollup bundles `src/` into a single `com.quickclips.streamdeck.sdPlugin/bin/plugin.js`. In watch mode, source maps are emitted; in production, output is minified by terser.

**Shared utilities:** `src/utils.ts` exports `applyTransform`, `generateLabel`, and `escapeForAppleScript` — used by both actions and covered by unit tests. All transforms are pure except `uuid`, which generates a fresh value per call.

**AppleScript escaping:** both actions build a `keystroke` script from arbitrary user text, so all interpolated text must go through `escapeForAppleScript`. AppleScript treats `\` as an escape character inside string literals — unescaped backslashes (Windows paths, regexes, escaped JSON, LaTeX) make `osascript` fail to compile, which previously surfaced as the button silently doing nothing. The helper doubles backslashes *before* escaping quotes, and converts newlines to `\n`/`\r` so the generated script stays on one line.

**Actions:**

`src/actions/clipboard-slot.ts` — **Quick Clips.** `ClipboardSlot` extends `SingletonAction<SlotSettings>`. Per-button hold timers tracked via `holdTrackers: Map<contextId, ...>`.
- `onKeyDown` starts a 1000ms timer; `onKeyUp` checks `tracker.clearMode` to distinguish click vs. hold
- Click on empty → `pbpaste` → store in settings; click on filled → simulate typing (default) or clipboard paste
- Hold → clear slot. Clear also available via property inspector `clearSlot` event to `onSendToPlugin`
- `SlotSettings`: `value`, `label`, `suppressClear`, `pasteMode`

`src/actions/clipboard-utils.ts` — **Quick Text Utils.** `ClipboardUtils` extends `SingletonAction<UtilSettings>`. Per-button hold timers tracked via `holdTrackers`.
- Click → read clipboard, apply stored transform, output via simulate typing (default) or clipboard paste
- Hold 1s → show `configure.png` icon, on release show `choose from list` osascript dialog to pick transform
- `count` transform is handled separately — shows a `display dialog` with word/char/line counts rather than outputting text
- **Generators** (`uuid`, `dateiso`, `datetimeiso`, `unixtime`) produce their own output and ignore clipboard input, so `onKeyUp` skips both the clipboard read and the empty-clipboard `showAlert()` guard for them — gated on `isGenerator()` from `src/utils.ts`, not a hardcoded id. They are the only impure cases in `applyTransform`
- Date generators format the **local** calendar date, never `toISOString()`, which formats in UTC and reports the wrong day whenever local and UTC dates differ. `datetimeiso` takes a single `Date` instance so its date and time cannot straddle a midnight rollover
- Adding a transform touches six tables in `clipboard-utils.ts` plus `ui/clipboard-utils.html`; the `Record<TransformType, …>` types make most omissions a compile error, but `PICKER_GROUPS`, `TRANSFORM_GROUPS`, `LABEL_TO_TRANSFORM`, and the `<option>` list are not type-checked for completeness
- Hold-to-configure prefers the rich browser picker (`src/picker.ts`); `promptTransformViaOsascript` is the fallback when no Chromium-family browser is installed
- osascript `choose from list` must run from a temp file (not stdin) to return the selected value correctly
- `UtilSettings`: `transform`, `pasteMode`

**Transform picker:** `src/picker.ts` renders the hold-to-configure list as a command-palette-style page served on an ephemeral `127.0.0.1` port. `findBrowser()` picks the window host: the bundled native host (`bin/picker-host`) if built, else a Chromium `--app=` window, else the osascript fallback.
- **Native host** (`native/picker-host.swift`, built by `npm run build:native`) is a ~150-line Swift/WKWebView window. Build output is gitignored like `plugin.js` but included by `streamdeck pack`. It is **unsigned** — fine locally, but distribution needs a Developer ID certificate and notarization or Gatekeeper blocks it
- It injects `window.__nativeHost = true` at documentStart; the page's head script then skips the `resizeTo`/`moveTo` correction, which exists only for Chrome. Do not use `.fullSizeContentView` on the window — it makes the frame equal the contentRect, reintroducing the 32px content shortfall and sliding the page header under the traffic lights
- The host writes its resolved geometry and any load failure to stderr, which `picker.ts` forwards to `onWarn` It supports icons, live previews of each transform against the current clipboard, type-to-filter with match highlighting, and keyboard nav.
- The browser executable is spawned **directly**, not via `open -a` — `open` drops `--args` when the browser is already running, which yields an ordinary tab instead of an app window
- `--window-size`/`--window-position` are likewise ignored when the browser is already running, so the page calls `resizeTo`/`moveTo` itself to size and centre the window; `screen.availLeft`/`availTop` centre it on the display it opened on and account for the menu bar
- A random per-invocation token gates every route, since any local process can reach the port; only icons named by the caller are servable
- It returns transform **ids**, not display strings, which is why `LABEL_TO_TRANSFORM` is needed only by the osascript fallback
- `TRANSFORM_ACCENTS` in `clipboard-utils.ts` mirrors the accent bar baked into each icon PNG — update both together if icons are redrawn
- Theme follows the OS by default; `theme: 'dark' | 'light'` overrides via a `data-theme` attribute that wins over the media query

**Settings persistence:** `setSettings()` called from the plugin side does NOT trigger `onDidReceiveSettings`, so `updateDisplay()` must be called manually after any plugin-side settings write.

**Property inspector:**
- `ui/clipboard-slot.html` — Paste Mode select, Prevent Clear checkbox, Clear Content button. Uses `SDPIComponents.streamDeckClient.send('sendToPlugin', ...)` directly (no sdpi-delegate).
- `ui/clipboard-utils.html` — Paste Mode select, Transform select with optgroup grouping.

**Releasing:** always via `npm run release`, never `npm run build` + pack by hand. Plain `build` does not produce the native host, and a package without it falls back to a browser *silently* — the failure is invisible without inspecting the archive. `scripts/verify-package.mjs` gates the release on four things that each nearly shipped broken: the host missing, its code signature invalid after `lipo`, the host not executable, and the packaged manifest version not matching the tree. Each check is proven to fail when it should.

Two packaging behaviours worth knowing:
- `streamdeck pack` stores **no permission bits** for any entry, so the host extracts non-executable; `findHosts()` repairs this at runtime (see above)
- It already excludes sourcemaps, so a stale `bin/plugin.js.map` from watch mode is harmless and needs no `.sdignore` rule

**Manifest:** `com.quickclips.streamdeck.sdPlugin/manifest.json` — defines both action UUIDs, button states, and icon paths. macOS 12+ only (Windows support deferred). Quick Text Utils uses font size 10 and bottom title alignment defined in manifest States.

**Visual states:**
- Quick Clips: 4 combinations of filled/empty × locked/unlocked. Locked variants use `setImage()` to override state defaults.
- Quick Text Utils: empty state shows `imgs/actions/utils/empty.png`, configured state shows per-transform icon from `TRANSFORM_ICONS`, hold state shows `imgs/actions/utils/configure.png`.
