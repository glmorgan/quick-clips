# Clipboard Slot Plugin - POC Documentation

## Overview

A Stream Deck plugin that provides reusable clipboard slots for storing and restoring text values with automatic paste functionality.

## Installation

### Prerequisites
- Stream Deck software (version 6.9 or later)
- macOS 12 or later / Windows 10 or later
- Node.js 20 (automatically managed by Stream Deck)

### Installing the Plugin

1. **Download or Clone** this repository to your local machine

2. **Build the plugin**:
   ```bash
   cd /path/to/dynamic-copy
   npm install
   npm run build
   ```

3. **Install to Stream Deck**:
   ```bash
   # Link the plugin folder to Stream Deck plugins directory
   streamdeck link
   
   # Or manually copy to:
   # macOS: ~/Library/Application Support/com.elgato.StreamDeck/Plugins/
   # Windows: %appdata%\Elgato\StreamDeck\Plugins\
   ```

4. **Restart Stream Deck**:
   ```bash
   streamdeck restart com.glen-morgan.dynamic-copy
   ```

5. **Add to Stream Deck**: Open Stream Deck software and drag the "Clipboard Slot" action onto your device

### Development Setup

For active development with auto-reload:

```bash
# Watch mode - automatically rebuilds and restarts on file changes
npm run watch
```

## Features

### Clipboard Slot Action

Each slot button can store one piece of clipboard text and restore it later.

#### Button States

- **Empty**: Shows "Empty" with gray clipboard icon - slot has no stored value
- **Filled**: Shows label (first 16 chars or full text) with blue clipboard icon with checkmark - contains stored value

#### Interactions

**Quick Click (< 1 second)**
- Empty slot: Captures current clipboard content into slot
- Filled slot: Copies stored value to clipboard AND auto-pastes it (simulates Cmd+V)

**Hold for 1 Second**
- Button text changes to "Release to Clear"
- On release: Clears the slot and returns to empty state

## Technical Implementation

### Clipboard Access
- Uses macOS `pbpaste` command to read clipboard
- Uses macOS `pbcopy` command via spawn with stdin to write clipboard
- Simulates Cmd+V using AppleScript for auto-paste
- Plain text only (no rich text or images)

### State Persistence
- Each slot stores: `value`, `label`
- State persisted via Stream Deck SDK `setSettings/getSettings`
- Survives Stream Deck restarts

### Hold-to-Clear Detection
- 1000ms (1 second) threshold
- Timer started on `keyDown`
- If timer completes: shows "Release to Clear" text
- On `keyUp`: if in clear mode, clears slot; otherwise executes normal click

### Visual Feedback
- Two icon states (empty and filled) automatically switch based on slot content
- Icons located in `imgs/actions/clipboard/`
- Empty: gray clipboard icon
- Filled: blue clipboard icon with checkmark badge

### Label Generation
- Text > 40 chars: first 16 chars + "…"
- Text ≤ 40 chars: full text

## Usage Flow

1. **Add Clipboard Slot button** to Stream Deck
2. **Copy text** you want to store (Cmd+C)
3. **Click empty slot** to capture clipboard content
4. **Click filled slot** anytime to paste that text (auto-pastes via Cmd+V)
5. **Hold for 1 second** then release to clear the slot

## Files Created/Modified

- `src/actions/clipboard-slot.ts` - Main action implementation with hold-to-clear logic
- `src/plugin.ts` - Registered new action
- `com.glen-morgan.dynamic-copy.sdPlugin/manifest.json` - Added action definition with 2 states
- `com.glen-morgan.dynamic-copy.sdPlugin/imgs/actions/clipboard/` - Icon files (empty and filled states)

## Building & Testing

```bash
# Build plugin
npm run build

# Watch mode (auto-rebuild and restart)
npm run watch

# Restart Stream Deck after changes
streamdeck restart com.glen-morgan.dynamic-copy
```

## Architecture Notes

### Why Hold-to-Clear Works This Way

The hold-to-clear logic uses a timer-based approach with visual feedback:

1. On `keyDown`: Start a 1000ms timer
2. If timer completes: Set `clearMode = true` and show "Release to Clear"
3. On `keyUp`: 
   - If `clearMode = true`: Clear the slot
   - Otherwise: Execute normal click (capture or paste)

This ensures:
- Clear visual feedback before clearing ("Release to Clear" text)
- No accidental clears on quick clicks
- Reliable state management without race conditions
- User has full control (can see they're about to clear before releasing)

### State Transitions

```
Empty → [click] → Filled (captures clipboard)
Filled → [click] → Filled (pastes stored text)
Any → [hold 1s, release] → Empty (clears slot)
```

## Limitations (POC)

- macOS only (uses pbpaste/pbcopy and AppleScript)
- Plain text only
- Placeholder icons (gray/blue clipboard - ready for UX designs)
- No property inspector UI
- 1 second hold required to clear (not configurable)

## Future Enhancements

- Rich text / image support
- Windows/Linux clipboard support  
- Custom icons from UX team
- Property inspector for manual label editing and hold duration
- Configurable auto-paste on/off toggle
- Support for multiple clipboard formats
