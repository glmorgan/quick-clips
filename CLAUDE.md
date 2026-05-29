# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # One-time build → com.quickclips.streamdeck.sdPlugin/bin/plugin.js
npm run watch        # Build + watch; auto-restarts plugin on save via `streamdeck restart`
streamdeck restart com.quickclips.streamdeck  # Manually restart plugin in Stream Deck
npx streamdeck dev   # Enable developer mode (required for streamdeck restart and plugin logging)
tail -f com.quickclips.streamdeck.sdPlugin/logs/com.quickclips.streamdeck.0.log  # Plugin logs
```

There is no test suite. Manual testing requires the Stream Deck app running with the plugin symlinked (see README for symlink setup). Developer mode must be enabled once per machine for `npm run watch` auto-restart to work.

## Architecture

This is an Elgato Stream Deck plugin built with the `@elgato/streamdeck` SDK v2. The plugin runs as a Node.js process that communicates with the Stream Deck app over WebSocket.

**Entry point:** `src/plugin.ts` — registers actions and calls `streamDeck.connect()`.

**Build output:** Rollup bundles `src/` into a single `com.quickclips.streamdeck.sdPlugin/bin/plugin.js`. The `sdPlugin/` directory is the complete deployable plugin package. In watch mode, source maps are emitted; in production, the output is minified by terser.

**Single action:** `src/actions/clipboard-slot.ts` — the entire plugin logic lives here. `ClipboardSlot` extends `SingletonAction<SlotSettings>` which means all buttons sharing this action type share one class instance. Per-button state (hold timers) is tracked via `holdTrackers: Map<contextId, ...>`.

**Interaction model:**
- `onKeyDown` starts a `setTimeout` for hold-to-clear detection (1000ms threshold)
- `onKeyUp` checks if the timer fired (`tracker.clearMode`) to distinguish click vs. hold
- Click on empty → `pbpaste` → store in settings; click on filled → simulate typing (default, via AppleScript `keystroke`) or clipboard paste (`pbcopy` + `Cmd+V`), controlled by `pasteMode` setting
- Clear is invoked either by hold-release or via the property inspector's "Clear Content" button (which sends a `clearSlot` event to `onSendToPlugin`)

**Settings persistence:** `SlotSettings` (`value`, `label`, `suppressClear`, `pasteMode`) is stored per-button by the Stream Deck SDK. Settings survive restarts. Note: `setSettings()` called from the plugin side does NOT trigger `onDidReceiveSettings`, so `updateDisplay()` must be called manually after any plugin-side settings write.

**Property inspector:** `com.quickclips.streamdeck.sdPlugin/ui/clipboard-slot.html` — uses `sdpi-components.js` web components. The `suppressClear` checkbox binds directly to settings. The "Clear Content" button uses a workaround: it clicks into the shadow DOM of an `<sdpi-delegate>` to trigger the `clearSlot` invoke event to the plugin.

**Manifest:** `com.quickclips.streamdeck.sdPlugin/manifest.json` defines the action UUID (`com.quickclips.streamdeck.clipboard-slot`), two button states (empty/filled with default images), and points to `bin/plugin.js` as the code path. macOS 12+ and Windows 10+ are declared; only macOS is currently implemented (clipboard tools are `pbpaste`/`pbcopy`/`osascript`).

**Visual states:** Four combinations of filled/empty × locked/unlocked. Empty and filled use manifest-defined state images (state 0/1 via `setState`). Locked variants override the image explicitly with `setImage("imgs/actions/clipboard/locked.png")` or `empty-locked.png`. Hold-in-progress shows `release-to-clear.png`.
