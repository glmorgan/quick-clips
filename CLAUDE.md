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

Tests cover pure functions in `src/utils.ts` and `src/typing.ts` only. **The action modules cannot be imported under vitest at all** — the `@elgato/streamdeck` decorator fails to parse — so anything inside an action class is verified by hand or by driving the real picker. Manual testing requires the Stream Deck app running with the plugin symlinked (see README). Developer mode must be enabled once per machine for `npm run watch` auto-restart to work.

## Architecture

This is an Elgato Stream Deck plugin built with the `@elgato/streamdeck` SDK v2. The plugin runs as a Node.js process that communicates with the Stream Deck app over WebSocket.

**Entry point:** `src/plugin.ts` — registers all three actions, calls `streamDeck.connect()`, and sets `process.chdir()` to the sdPlugin directory so the SDK can find `manifest.json` when relaunched via `streamdeck restart` (which otherwise sets CWD to the repo root via symlink resolution).

**Build output:** Rollup bundles `src/` into a single `com.quickclips.streamdeck.sdPlugin/bin/plugin.js`. In watch mode, source maps are emitted; in production, output is minified by terser.

## Text output (`src/typing.ts`)

Owns emitting text for all three actions — they each used to carry a copy, which is how the AppleScript backslash bug came to exist in two places.

**Paste modes** are separate from the mechanism used to deliver text. `PasteMode` is `auto | typing | clipboard`, and **`auto` is the default** for new buttons of every action:

- `auto` sends text as keystrokes, but routes anything containing a **newline or tab** through the clipboard, then restores the previous clipboard contents. Return and Tab are keys before they are characters — Return triggers auto-indent and submits forms, Tab moves focus or fires completion — so a pretty-printed JSON object typed into an editor arrives with its indentation compounded and its brackets doubled. Measured: the same JSON typed into a plain textarea, which has none of that machinery, arrives byte-identical. **The transformation belongs to the destination, not to how we send it.**
- `auto` deliberately does *not* try to detect brackets or quotes. Editors auto-close those on a single line too, but it varies per app and per language, and guessing would make the mode unpredictable.
- Explicit `clipboard` **leaves the text on the pasteboard**; `auto` borrows and restores it, because replacing the clipboard is a side effect the user did not ask for.

Existing buttons keep whatever is stored in their settings — there is no way to tell a value the user chose from one an old default wrote, so nothing is migrated.

**Delivery** tries three mechanisms, best first:
1. the bundled native helper (`bin/picker-host --type-text`, text on stdin), which posts Unicode via `CGEvent.keyboardSetUnicodeString` and is exact
2. AppleScript `keystroke`, but **only for printable ASCII** (`\x20-\x7E`). Everything else corrupts silently, all measured: non-ASCII becomes `a` (`→ café 🎉 日本語` → `a cafa aa aaa`), **newlines vanish entirely**, and **tabs are delivered as real Tab presses** that move focus, so the remainder is typed into the wrong field
3. borrowing the clipboard (copy, paste, restore) for anything else — silently wrong output is worse than a briefly borrowed pasteboard

A failed *restore* of the previous clipboard is reported through `onWarn`. It used to be swallowed, leaving the user's clipboard quietly replaced with no way to find out why.

Smart-quote substitution is *not* fixable here: macOS curls quotes in the receiving field, which affects real typing too and varies per app. Clipboard paste is immune.

**AppleScript escaping:** all interpolated text must go through `escapeForAppleScript`. AppleScript treats `\` as an escape character inside string literals — unescaped backslashes (Windows paths, regexes, escaped JSON, LaTeX) make `osascript` fail to compile, which previously surfaced as the button silently doing nothing. The helper doubles backslashes *before* escaping quotes, and converts newlines to `\n`/`\r` so the generated script stays on one line.

## The clip model (`src/utils.ts`)

`ClipEntry` is `{ id, value, addedAt, title?, hidden?, lastUsedAt? }`, capped at `MAX_CLIPS = 50` and `MAX_CLIP_CHARS = 10_000` because settings are JSON persisted into the Stream Deck profile.

- **Nothing is cached alongside the value.** There used to be a `label` holding a summary of it; nothing ever read it — every display path derives from the value at render time, so a row uses the window's real width rather than a cap fixed at capture. It cost about a third of the stored size and wrote a masked clip's secret into the profile **twice**. `normaliseClips` drops it from collections that still carry it, on `onWillAppear`, once. It removes named fields only — never "anything I do not recognise" — so a collection written by a newer version survives an older one reading it.
- **`title` is the user's name for a clip**, and a generated one is only ever a default. Clearing it falls back to describing the value again.
- **Order is stable.** Using a clip does not move it: the list is a curated set of references, not a history, so position is what makes it learnable — and ⌘1–9 would otherwise mean something different after every paste. `markClipUsed` records `lastUsedAt` without reordering. Only `addClip` moves anything, and only when re-capturing text already stored.
- **`lastUsedAt` exists solely for eviction.** At the cap, `addClip` drops the least recently *used*, not the oldest added — otherwise a clip stored first and pasted daily would go before one added later and never touched. It falls back to `addedAt`, which is the normal case since the field is optional.
- **`updateClip` and `restoreClip` refuse rather than break an invariant.** `addClip` guarantees no two clips share a value, so an edit that would duplicate one is declined, as is an undo whose text is already back. `restoreClip` restores by index, clamped.
- **`detectClipKind` uses only verifiable rules** — JSON is `JSON.parse`d and restricted to objects/arrays, JWT headers are base64url-decoded and checked for `alg`, IPs go through `net.isIP`, dates round-trip through `Date`. There is deliberately **no "code" kind**: it cannot be detected without guessing.
- **`clipRowText` / `clipSearchText`** derive what a row shows and what the filter matches. A hidden clip returns a fixed-width `MASK` and is searchable **by name only** — matching on the value would highlight the row as you typed the secret.
- Hiding is **masking, not security**: the value is plain text in the profile and pastes verbatim. It defends against someone reading your screen and nothing else.

## Secret detection (`classifySecret` in `src/utils.ts`)

**This recognises a few well-known shapes. It does not detect secrets.** A short password, an
internal token with no distinguishing format, anything under 32 characters — all pass straight
through. A negative means "nothing matched", never "this is safe", and the code says so.

The verdict carries a `confidence` of `identified | heuristic | none`, and **the distinction is in
the type on purpose** so it cannot be flattened by a later refactor. Recognising `ghp_` is
identification; "this looks random" is a guess, and only one has earned trust. The two read
differently in the UI for the same reason.

Order does real work, and it is not arbitrary:

1. **explicit allows first** — a Stripe `pk_live_` publishable key is *meant* to be public, and
   masking it for looking random would be actively wrong
2. **rules that identify what the value is** — published vendor prefixes (GitHub, GitLab, Stripe,
   Slack, AWS, Google, Anthropic, npm, SendGrid, PEM private keys), a JWT whose header actually
   decodes to an object with `alg`, a URL with a non-empty password, and **context**:
   `Authorization:` / `Proxy-Authorization:` headers, a bare `Bearer <token>`, base64 decoding to
   `user:password`, and an assignment to a credential-shaped field name
3. **a second allow** — base64 that decodes to readable text is encoded data, not an opaque secret
4. **only then the shape heuristic** — long, single-line, no whitespace, ≥4.5 bits/char entropy

Three things that were measured rather than assumed:

- **Hex caps at 4 bits per character**, so UUIDs (3.88), git SHAs (3.83) and every hash sit below
  the entropy threshold on their own. They were never the false positives they appear to be
- **Context used to make things worse.** A token wrapped in `Authorization: Bearer …` contains a
  space, which defeats the shape heuristic — so before the context rules, adding the proof that a
  value was a credential made it *less* likely to be masked than the bare token
- **The base64 allow was clearing Basic credentials.** `dXNlcjpwdw==` decodes to readable text, and
  that text is a username and password. An allow that overrides is worse than a plain miss, which
  is why the userinfo check runs before it

**Auto-masking** happens on capture only, and only for a genuinely new clip — re-capturing text you
deliberately unhid must not hide it again, or the setting could never stick. `applySecretVerdict`
masks it and gives it a generated name.

**The generated name is not cosmetic.** Masking costs a clip its searchability, because
`clipSearchText` returns the title alone for a hidden clip — deliberately, so typing a secret
cannot highlight its row. An unnamed masked clip is therefore findable by nothing and renders as
the same twelve dots as every other one. The name restores both. It is deliberately generic
("GitHub token", not the service-plus-anything), except for the assignment rule which names the
clip after the **field** (`x-api-key`), since a field name was never the secret.

**Existing clips are never re-classified.** A clip captured before a rule existed stays unmasked.
That is deliberate: a clip that was never classified and one the user *deliberately unmasked* both
simply lack `hidden`, so automatic re-scanning would silently re-hide things the user chose to
show, with no way to stop it. An explicit user-triggered re-scan is the open option.

## Actions

`src/actions/clipboard-slot.ts` — **Quick Clips.** `ClipboardSlot` extends `SingletonAction<SlotSettings>`. Per-button hold timers tracked via `holdTrackers: Map<contextId, ...>`.
- `onKeyDown` starts a 1000ms timer; `onKeyUp` checks `tracker.clearMode` to distinguish click vs. hold
- Click on empty → `pbpaste` → store in settings; click on filled → output via the paste mode
- Hold → clear slot. Clear also available via property inspector `clearSlot` event to `onSendToPlugin`
- `SlotSettings`: `value`, `label`, `suppressClear`, `pasteMode`

`src/actions/clipboard-utils.ts` — **Quick Text Utils.** `ClipboardUtils` extends `SingletonAction<UtilSettings>`.
- Click → read clipboard, apply stored transform, output via the paste mode
- Hold 1s → show `configure.png` icon, on release open the picker to choose a transform
- `count` is handled separately — shows a `display dialog` with word/char/line counts rather than outputting text
- **Generators** (`uuid`, `dateiso`, `datetimeiso`, `unixtime`, `unixtimems`) produce their own output and ignore clipboard input, so `onKeyUp` skips both the clipboard read and the empty-clipboard `showAlert()` guard — gated on `isGenerator()`, not a hardcoded id. They are the only impure cases in `applyTransform`
- Date generators format the **local** calendar date, never `toISOString()`, which formats in UTC and reports the wrong day whenever local and UTC dates differ. `datetimeiso` takes a single `Date` instance so its date and time cannot straddle a midnight rollover
- Adding a transform touches six tables in `clipboard-utils.ts` plus `ui/clipboard-utils.html`; the `Record<TransformType, …>` types make most omissions a compile error, but `PICKER_GROUPS`, `TRANSFORM_GROUPS`, `LABEL_TO_TRANSFORM`, and the `<option>` list are not type-checked for completeness
- `promptTransformViaOsascript` is the fallback when no window host exists. osascript `choose from list` must run from a **temp file, not stdin**, to return the selected value correctly
- `UtilSettings`: `transform`, `pasteMode`

`src/actions/clipboard-manager.ts` — **Quick Clips Manager.** One key holds a whole named collection; the picker chooses between them. Suits the long tail of per-project details, while frequently pasted values still belong on their own Quick Clip keys.
- **Short press** opens the picker. **Hold 1s** captures the clipboard directly, showing `release-to-add.png` and a "Release to Add" title at the threshold. The hold is deliberately not suppressible the way hold-to-clear is: an accidental capture files one clip too many, where an accidental clear destroys the only copy of something
- `open: Set<contextId>` prevents a second window for the same button. **This guards the hold as well as the press** — an open picker holds the collection in a closure and writes it back on its next mutation, so a capture from the key would be silently clobbered. `onKeyDown` does not even arm the timer in that state
- `pick()` takes a **`() => clips` getter, not the array**. It runs for the life of the window and every mutation replaces the list, so anything captured by value goes stale — which once made a second add overwrite the first
- `lastDeleted` backs undo. **Window-lifetime only and never persisted**: undo exists to take back a misaimed click, and persisting it would make this a trash can where clips you meant to destroy quietly linger
- `EDIT_REFUSALS` maps a refusal reason to text for the picker's toast. A `duplicate` refusal clears `lastDeleted` (it can never succeed); a `full` one leaves it live for a retry
- `SECRET_BADGE` wins over the shape kind, because on a masked row the value is dots — "URL" says nothing while "SECRET" says the one useful thing. Derived from the value rather than from `hidden`, so unhiding a clip to read it does not stop it being a credential, and deliberately generic: naming the service would tell anyone glancing at the screen which credential it is, which is most of what masking withholds
- `KIND_BADGES` / `buildBadge` badge every other row by detected kind. A detected colour renders as **the colour itself** rather than the word — the one kind where the value carries more than its name. Badge `search` text carries synonyms so "colour", "hex" and "token" all find the right rows
- `ManagerSettings`: `name`, `clips`, `pasteMode`

## The picker (`src/picker.ts`)

One page serves both the transform grid and the clip list, on an ephemeral `127.0.0.1` port. A random per-invocation token gates every route, since any local process can reach the port; only icons named by the caller are servable.

`findHosts()` returns ordered candidates: the bundled native host (`bin/picker-host`) if built, then Chromium-family browsers. It **chmods 0755** to repair the exec bit `streamdeck pack` discards.

**Layout.** `layout: "grid"` packs terse labelled items into columns (transforms); `layout: "list"` gives each row full width (clips). In list layout clip rows **stack the name above the value**. They shared a line originally, and flexbox distributes shrinkage in proportion to content length, so a long value crushed a clip named "JSON" down to "JSO…". Stacking retires the problem rather than refereeing it. Row line-heights are pinned (18 + 3 + 16 = 37) so every row is exactly 57px whether it has a name, wraps to two lines, or fits on one — left to font metrics, a short unnamed clip came out 3px shorter than the rest.

**Options** are the whole API: `title`, `subtitle`, `selectedId`, `actions` + `onAction`, `onDelete`, `onUndoDelete`, `onEdit` + `onReadValue`, `onToggleHidden`, `layout`, `width`, `height`, `filterPlaceholder`, `showGroupCounts`, `quickSelect`, `awaitFocusHandoff`, `timeoutMs`, `theme`, `onWarn`. Supplying a callback is what makes its control appear.

**Message protocol** (POST `/message`): `select`, `action`, `delete`, `undo`, `read`, `edit`, `hide`, `error`. Everything except `select` leaves the window open.

`onAction` may return `{ items, notice }` rather than a bare list — a success that has something to
say, distinct from throwing, which reports a failure and leaves the list alone. It exists because a
row silently turning to dots is confusing: the notice explains why a captured clip arrived masked.

**Rendering rules that matter:**
- A **delete removes the row in place**; everything else calls `refresh()`. Neither `location.reload()` nor `location.replace()` re-renders inside the native web view, so `refresh()` fetches fresh markup and swaps `main .wrap`, which also preserves filter text and scroll position
- Anything derived from the list — the group tally, the ⌘1–9 numbering — is computed in **`paint()`, not server-side**, precisely because a delete does not re-render
- `paint(fromPointer)` suppresses `scrollIntoView`. Bringing the selection into view is for keyboard navigation; under the pointer the row is already there, and scrolling shifts whatever sits under a stationary mouse
- The body is `visibility: hidden` until the head script adds `.ready`. This exists to stop a resize flash, and has a consequence worth remembering: **elements inside a hidden subtree cannot take focus**, so anything measuring focus must wait for `.ready`

**Editing** expands the row into a name field and a text area. The text is **fetched on demand** (`onReadValue`) rather than embedded in every row, which keeps whole collections out of the page and a masked clip's value out of the DOM until that row is deliberately opened. ⌘↵ saves, Escape cancels, and there is **no commit-on-blur** — tabbing between the two fields would fire it. A refusal keeps the editor open with the text intact. `beginEdit` re-resolves the live row when the text arrives, because a refresh may have replaced every node while the fetch was in flight.

**Undo** offers to restore the last delete for 8 seconds, via the toast or ⌘Z. ⌘Z is only claimed while an undo is pending, so the filter field keeps its native text undo the rest of the time.

**Deleting** collapses the row rather than removing it outright. The card leaves the `cards` array immediately and only its pixels lag, so navigation and filtering can never reach a row on its way out. Skipped entirely under `prefers-reduced-motion`.

**⌘1–9 quick select** (`quickSelect`) numbers the **visible** rows, so the shortcuts follow the filter. The modifier is not optional — stored text is full of digits, and a bare number would paste a row instead of filtering for it. Numbers appear only while ⌘ is held, positioned over the controls (which are hidden with `visibility`, so nothing reflows). **The choice is held until the modifier is released**, because selecting types into whatever app is frontmost within tens of milliseconds, and a held modifier turns typed characters into shortcuts.

**Reordering** (`onReorder`) binds Alt+Up and Alt+Down to `moveClip`. Refused while the filter has
text, with a notice saying so: the rows on screen are not adjacent in the collection then, so a
move would swap the clip past neighbours the user cannot see. Movement is clamped rather than
wrapped, and `refresh()` restores the selection by id, so the highlight rides along with the clip
and the key can be held to move it several places. Capture still prepends, so a new clip lands at
the top of a curated list by design.

**The filter's clear button** is toggled by a class from `applyFilter()`, *not* by `#q:placeholder-shown ~ #clear`. Chrome does not invalidate that sibling selector when the value changes programmatically — measured: the selector matched nothing while the computed style stayed `hidden`, even after a forced reflow. It is hidden with `visibility` so its box stays reserved and the search bar does not change height.

**Browser fallback specifics:** the executable is spawned **directly**, not via `open -a` — `open` drops `--args` when the browser is already running, yielding an ordinary tab instead of an app window. `--window-size`/`--window-position` are likewise ignored when it is already running, so the page calls `resizeTo`/`moveTo` itself; `screen.availLeft`/`availTop` centre it on the display it opened on.

## Native window host (`native/picker-host.swift`)

Built by `npm run build:native`. Output is gitignored like `plugin.js` but included by `streamdeck pack`. **Ad-hoc signed only** — fine locally, but distribution needs a Developer ID certificate and notarization or Gatekeeper blocks it.

- Injects `window.__nativeHost = true` at documentStart so the page skips the `resizeTo`/`moveTo` correction, which exists only for Chrome
- **Do not use `.fullSizeContentView`** — it makes the frame equal the contentRect, reintroducing a 32px content shortfall and sliding the page header under the traffic lights
- `.accessory` activation policy, not `.regular`. A transient picker should not register as a full application; the regular policy adds a Dock icon and the whole app-launch ceremony, which is what made opening feel slow. Accessory windows still take keyboard focus, and **Cmd+V still works in the filter field** — verified, because that was the risk
- A minimal **Edit menu** supplies the key equivalents for Cmd+X/C/V/A. Without a menu bar AppKit has no key equivalent for Cmd+V, so pasting into the filter field silently did nothing
- Every surface visible before the first paint uses `pageBackground` (#333333, mirroring `--bg`), and the window is pinned to `.darkAqua`. `NSColor.windowBackgroundColor` is dynamic and resolves to **#FFFFFF under the light appearance** while the page is always dark — that was a white flash on a Mac set to Light mode
- `typeText` **clears each event's flags** and waits for Command/Control/Option to be released first. An event created from a source inherits that source's flags, and `.hidSystemState` is the live hardware state, so a key still held rides along on every character and the receiving app reads them as shortcuts
- A parent watchdog exits when the plugin process goes away, so a re-parented window cannot linger with every control hitting a dead server
- The host writes resolved geometry and any load failure to stderr, which `picker.ts` forwards to `onWarn`

## Settings persistence

`setSettings()` called from the plugin side does **not** trigger `onDidReceiveSettings`, so `updateDisplay()` must be called manually after any plugin-side settings write.

## Property inspectors

All three expose **Paste Mode** as Automatic (default) / Simulate Typing / Clipboard Paste.
- `ui/clipboard-slot.html` — plus Prevent Clear checkbox and Clear Content button. Uses `SDPIComponents.streamDeckClient.send('sendToPlugin', ...)` directly (no sdpi-delegate)
- `ui/clipboard-utils.html` — plus Transform select with optgroup grouping
- `ui/clipboard-manager.html` — plus Collection Name and a Clear All Clips button

## Releasing

Always via `npm run release`, never `npm run build` + pack by hand. Plain `build` does not produce the native host, and a package without it falls back to a browser *silently* — invisible without inspecting the archive.

`scripts/verify-package.mjs` gates the release on things that each nearly shipped broken: the packaged manifest version not matching the tree, the bundle missing or truncated, the native host missing, not executable, not universal, or with a code signature invalidated by `lipo`, the bundle being an unminified watch build, and any icon referenced by the code but absent from the package. Each check is proven to fail when it should.

Two packaging behaviours worth knowing:
- `streamdeck pack` stores **no permission bits** for any entry, so the host extracts non-executable; `findHosts()` repairs this at runtime
- It already excludes sourcemaps, so a stale `bin/plugin.js.map` from watch mode is harmless and needs no `.sdignore` rule

## Manifest and visual states

`com.quickclips.streamdeck.sdPlugin/manifest.json` defines all three action UUIDs, button states and icon paths. macOS 12+ only (Windows support deferred). Quick Text Utils uses font size 10 and bottom title alignment defined in manifest States.

- **Quick Clips:** 4 combinations of filled/empty × locked/unlocked. Locked variants use `setImage()` to override state defaults
- **Quick Text Utils:** empty shows `imgs/actions/utils/empty.png`, configured shows the per-transform icon from `TRANSFORM_ICONS`, hold shows `imgs/actions/utils/configure.png`
- **Quick Clips Manager:** empty/filled state art, plus `release-to-add.png` shown via `setImage()` during a hold. `updateDisplay()` clears any image override before setting state, so a hold prompt cannot get stuck on the key
- `TRANSFORM_ACCENTS` in `clipboard-utils.ts` mirrors the accent bar baked into each icon PNG — update both together if icons are redrawn
- Icons for `setImage()` are a **single high-resolution file** (288×288), not a `@2x` pair: `setImage` takes a literal path and does no density lookup. Manifest state images use the base-name convention with `@2x` siblings
