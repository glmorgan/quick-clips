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
npx streamdeck pack com.quickclips.streamdeck.sdPlugin --force  # Create distributable .streamDeckPlugin file
tail -f com.quickclips.streamdeck.sdPlugin/logs/com.quickclips.streamdeck.0.log  # Plugin logs
```

Tests cover pure functions in `src/utils.ts` only. Manual testing requires the Stream Deck app running with the plugin symlinked (see README). Developer mode must be enabled once per machine for `npm run watch` auto-restart to work.

## Architecture

This is an Elgato Stream Deck plugin built with the `@elgato/streamdeck` SDK v2. The plugin runs as a Node.js process that communicates with the Stream Deck app over WebSocket.

**Entry point:** `src/plugin.ts` — registers both actions, calls `streamDeck.connect()`, and sets `process.chdir()` to the sdPlugin directory so the SDK can find `manifest.json` when relaunched via `streamdeck restart` (which otherwise sets CWD to the repo root via symlink resolution).

**Build output:** Rollup bundles `src/` into a single `com.quickclips.streamdeck.sdPlugin/bin/plugin.js`. In watch mode, source maps are emitted; in production, output is minified by terser.

**Shared utilities:** `src/utils.ts` exports `applyTransform` and `generateLabel` — pure functions used by both actions and covered by unit tests.

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
- osascript `choose from list` must run from a temp file (not stdin) to return the selected value correctly
- `UtilSettings`: `transform`, `pasteMode`

**Settings persistence:** `setSettings()` called from the plugin side does NOT trigger `onDidReceiveSettings`, so `updateDisplay()` must be called manually after any plugin-side settings write.

**Property inspector:**
- `ui/clipboard-slot.html` — Paste Mode select, Prevent Clear checkbox, Clear Content button. Uses `SDPIComponents.streamDeckClient.send('sendToPlugin', ...)` directly (no sdpi-delegate).
- `ui/clipboard-utils.html` — Paste Mode select, Transform select with optgroup grouping.

**Manifest:** `com.quickclips.streamdeck.sdPlugin/manifest.json` — defines both action UUIDs, button states, and icon paths. macOS 12+ only (Windows support deferred). Quick Text Utils uses font size 10 and bottom title alignment defined in manifest States.

**Visual states:**
- Quick Clips: 4 combinations of filled/empty × locked/unlocked. Locked variants use `setImage()` to override state defaults.
- Quick Text Utils: empty state shows `imgs/actions/utils/empty.png`, configured state shows per-transform icon from `TRANSFORM_ICONS`, hold state shows `imgs/actions/utils/configure.png`.
