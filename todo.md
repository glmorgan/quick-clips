# Quick Clips — Todo

## Bug Fixes / Rough Edges

- [ ] **Windows clipboard support** — removed from manifest until a Windows machine is available for testing. Will need `clip.exe` / PowerShell equivalents and runtime platform detection.

- [x] **Silent failure on empty clipboard** — `showAlert()` now fires when clipboard is empty on capture attempt.

- [x] **Hold tracker memory leak** — `onWillDisappear` now cleans up the tracker entry on button removal.

- [x] **Property inspector shadow DOM hack** — replaced with direct `SDPIComponents.streamDeckClient.send()` call.

---

## Functional Improvements

- [ ] **Multi-slot clipboard history per button** — instead of one stored value, cycle through a small history (e.g. last 3 clips). Short press pastes the most recent; hold cycles to the next.

- [x] **Text transformation options** — implemented as Quick Text Utils action with 12 transforms plus word/char/line count. Hold 1s to reconfigure.

- [x] **Named slots / custom labels** — covered by Stream Deck's native title field.

- [x] **Simulate typing paste mode** — per-button setting on both Quick Clips and Quick Text Utils; default is simulate typing.

---

## Marketplace Readiness

- [ ] **Icon redesign** — redo Quick Clips icons in new style to match Quick Text Utils set. Need @2x variants for all.

  **Quick Clips** (`imgs/actions/clipboard/`):
  - [ ] `empty.png` / `empty@2x.png`
  - [ ] `empty-locked.png` / `empty-locked@2x.png`
  - [ ] `filled.png` / `filled@2x.png`
  - [ ] `locked.png` / `locked@2x.png`
  - [ ] `release-to-clear.png` / `release-to-clear@2x.png`
  - [ ] `icon.png` / `icon@2x.png` *(action icon in Stream Deck panel)*

  **Quick Text Utils** (`imgs/actions/utils/`): ✓ all done
  - [x] `empty.png` / `empty@2x.png`
  - [x] `configure.png` / `configure@2x.png`
  - [x] `upper.png` / `upper@2x.png`
  - [x] `lower.png` / `lower@2x.png`
  - [x] `titlecase.png` / `titlecase@2x.png`
  - [x] `camelcase.png` / `camelcase@2x.png`
  - [x] `snakecase.png` / `snakecase@2x.png`
  - [x] `dashcase.png` / `dashcase@2x.png`
  - [x] `base64encode.png` / `base64encode@2x.png`
  - [x] `base64decode.png` / `base64decode@2x.png`
  - [x] `urlencode.png` / `urlencode@2x.png`
  - [x] `urldecode.png` / `urldecode@2x.png`
  - [x] `trim.png` / `trim@2x.png`
  - [x] `count.png` / `count@2x.png`
  - [x] `icon.png` / `icon@2x.png`

  **Plugin-level** (`imgs/plugin/`):
  - [ ] `category-icon.png` / `category-icon@2x.png`
  - [ ] `marketplace.png` / `marketplace@2x.png` *(main plugin marketplace image)*

- [ ] **Website** — index.html updated; screenshots deferred until closer to public launch.

- [ ] **Pack and submit** — `npx streamdeck pack` once icons and screenshots are complete. Validation passes with 4 @2x warnings (all icon-related).

- [ ] **Onboarding state** — Quick Clips empty state could be more descriptive for first-time users.

- [ ] **Discoverability of hold gestures** — hold-to-clear (Quick Clips) and hold-to-configure (Quick Text Utils) are not obvious without docs.

---

## Stretch / Interesting Variants

- [ ] **Sequence mode** — button pastes clips in order each press (clip 1, clip 2, clip 3, loops). Useful for multi-step form filling.

- [ ] **Expiring clips** — clips that auto-clear after N minutes or after first paste. Useful for OTPs or temp passwords.

- [ ] **Pattern templates** — store a template with a placeholder (e.g. `Hello {{name}}`), prompt for fill-in on paste.

- [ ] **Windows implementation** — required for wider marketplace audience.
