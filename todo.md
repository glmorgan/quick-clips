# Quick Clips — Todo

## Bug Fixes / Rough Edges

- [ ] **Windows clipboard support** — removed from manifest until a Windows machine is available for testing. Will need `clip.exe` / PowerShell equivalents and runtime platform detection.

- [x] **Silent failure on empty clipboard** — pressing an empty slot when clipboard is also empty does nothing and shows no feedback. Should call `showAlert()` or briefly show a message so the user knows why nothing happened.

- [x] **Hold tracker memory leak** — `holdTrackers` entries are removed on `onKeyUp` but not on button removal. Add `onWillDisappear` to clean up the entry for that `contextId` so removed buttons don't leak timers.

- [x] **Property inspector shadow DOM hack** — the "Clear Content" button manually clicks into the `<sdpi-delegate>` shadow root to trigger `clearSlot`. This is fragile against `sdpi-components.js` updates. Investigate whether a direct `sendToPlugin` call from a plain `<button>` click handler is possible without the delegate.

---

## Functional Improvements

- [ ] **Multi-slot clipboard history per button** — instead of one stored value, cycle through a small history (e.g. last 3 clips). Short press pastes the most recent; hold cycles to the next. Useful for users who frequently rotate between a small set of values.

- [ ] **Text transformation options** — optional per-button transforms applied on paste: UPPERCASE, lowercase, trim whitespace, strip formatting. Adds power-user appeal without changing the core workflow.

- [ ] **Named slots / custom labels** — let users type a static name in the property inspector that overrides the auto-generated label. Useful for semi-permanent clips (e.g. a button always labeled "Email" that stores whichever email address is current).

- [x] **Simulate typing paste mode** — per-button setting; default is simulate typing (doesn't clobber clipboard); fallback is clipboard paste (Cmd+V) — an "Enter text manually" field in the property inspector to pre-fill a slot without needing it on the clipboard first. Opens the plugin to static snippets as a use case.

- [ ] **Copy-only mode** — an option to capture to the slot without immediately being usable for paste (i.e. just a storage action), useful for users building a set of clips before starting a paste-heavy task.

---

## Marketplace / Discovery Improvements

- [ ] **Onboarding state** — first-time appearance (no settings ever set) could show "Copy text, then press me" as the title instead of "Empty" to make the interaction model self-documenting.

- [ ] **Discoverability of hold-to-clear** — consider a brief animation or title flash ("Hold 1s to clear") when a filled button is first pressed, before the long-press threshold fires. Users who never read docs often miss hold gestures entirely.

- [ ] **Windows implementation** — required for a wider marketplace audience. Clipboard: `Get-Clipboard` / `Set-Clipboard` via PowerShell. Paste simulation: `SendKeys` via PowerShell or a small native helper.

- [ ] **Profile export/import** — a way to back up or share a set of named clips. Could be as simple as a JSON file the user drags in via the property inspector.

- [ ] **Marketplace screenshots and demo GIF** — the docs/images folder has stills; a short GIF showing the capture → paste → clear workflow would significantly improve conversion on the marketplace listing.

---

## Stretch / Interesting Variants

- [ ] **Sequence mode** — a button that pastes clips in order each press (clip 1, then clip 2, then clip 3, then loops). Useful for multi-step form filling or repetitive data entry.

- [ ] **Shared clipboard pool** — optional sync across buttons on the same deck so one "capture" button fills multiple paste buttons simultaneously (e.g. capture once, paste in multiple apps).

- [ ] **Expiring clips** — clips that auto-clear after N minutes or after first paste. Useful for one-time values like OTPs or temp passwords where leaving them stored is a security risk.

- [ ] **Pattern templates** — store a template with a placeholder (e.g. `Hello {{name}}`) and have the property inspector prompt for the fill-in value on paste. Bridges clipboard tool and text-snippet tool use cases.


Stream Deck SDK
This is a test of simulated typing
Stream Deck SDK
This is a test of simulated typing
Stream Deck SDK
