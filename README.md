# Quick Clips

A Stream Deck plugin that provides reusable clipboard slots for capturing, storing, and pasting text content.

## What It Does

Quick Clips turns your Stream Deck buttons into clipboard storage slots. Unlike static text buttons that require opening the Stream Deck UI to configure, Quick Clips buttons dynamically capture whatever text is currently on your clipboard with a single press.

Keep several Quick Clip buttons on your Stream Deck. When you copy text you want to reuse, click an empty slot to store it. Click again to paste. When you're done with that text, hold to clear the slot and it's ready for the next clip. No UI configuration needed.

Useful for text that changes throughout your workflow—temporarily storing code snippets, API responses, email addresses, URLs, or any text you need multiple times before moving on to something else.

## Features

- **One-Click Capture & Paste** - Click when empty to capture current clipboard, click when filled to paste
- **Dynamic Content** - Captures whatever text is on your clipboard at the moment you click
- **Prevent Clear** - Optional lock mode to protect stored clips
- **Hold-to-Clear** - Press and hold for 1 second to clear a slot (when not locked)
- **Visual Feedback** - Icons indicate empty, filled, and locked states
- **Persistent Storage** - Clips survive app restarts and profile switches
- **Manual Clear** - Clear button in settings for quick reset

## Installation

### From Stream Deck Marketplace (Recommended)

1. Open the Stream Deck application
2. Navigate to the Marketplace
3. Search for "Quick Clips"
4. Click Install

### Manual Installation (Development)

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/quick-clips.git
   cd quick-clips
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Link the plugin to Stream Deck:
   ```bash
   ln -s "$(pwd)/com.quickclips.streamdeck.sdPlugin" \
     "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/"
   ```

5. Restart Stream Deck

## How It Works

### Basic Usage

1. **Add a Quick Clip button** to your Stream Deck from the Actions panel
2. **Click the empty button** to capture current clipboard content
3. **Click the filled button** to paste stored content into the active app
4. **Hold for 1 second** to clear the slot (displays "Release to Clear" feedback)

### Advanced Features

#### Prevent Clear (Lock Mode)
Enable this in the button's property inspector to:
- Disable hold-to-clear functionality
- Show a lock icon to indicate protected status
- Preserve clips from accidental clearing

You can still manually clear using the "Clear Stored Content" button in settings.

#### Visual States

The button displays different icons based on its state:

| State | Icon | Description |
|-------|------|-------------|
| Empty (unlocked) | Gray clipboard | Ready to capture |
| Empty (locked) | Locked clipboard | Protected, ready to capture |
| Filled (unlocked) | Blue clipboard | Contains content, can be cleared |
| Filled (locked) | Lock icon | Protected content |

### Property Inspector

Right-click any Quick Clip button to access:
- **Prevent Clear** checkbox - Enable/disable hold-to-clear
- **Clear Stored Content** button - Manually reset the slot

## Platform Support

- **macOS** - Supported (tested on macOS 10.15+)
- **Windows** - Planned for future release
- **Linux** - Planned for future release

## Development

### Build
```bash
npm run build
```

### Watch Mode
```bash
npm run watch
```

### Restart Plugin
```bash
streamdeck restart com.quickclips.streamdeck
```

## Technical Details

- Built with TypeScript and the Elgato Stream Deck SDK v2.0
- Uses native macOS clipboard utilities (pbpaste/pbcopy)
- Settings stored persistently in Stream Deck profiles
- No external dependencies or network access

## License

MIT

## Author

Glen Morgan

## Support

For issues, feature requests, or questions, please visit the [GitHub repository](https://github.com/yourusername/quick-clips/issues).

