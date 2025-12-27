# Quick Clips

Turn your Elgato Stream Deck into a set of reusable clipboard slots. Capture text once, paste it on demand, clear it when you're done, and reuse the button for whatever comes next. All without touching the Stream Deck UI.

## What It Does

Quick Clips turns Stream Deck buttons into flexible clipboard slots. Instead of setting up static text buttons in the Stream Deck UI, each button can grab whatever text is currently on your clipboard with a single press.

Keep a few Quick Clip buttons on your Stream Deck. When you copy something you want to reuse, press an empty button to store it. Press the same button again to paste it into the active app. When you are finished with that text, press and hold to clear the slot so it is ready for the next clip. There is no need to open the Stream Deck configuration UI during your workflow.

This is especially useful for text that changes often, such as code snippets, API values, email addresses, URLs, or anything you need to paste multiple times before moving on.

## Features

- **One-click capture and paste**  
  Click an empty button to capture the clipboard, click a filled button to paste

- **Dynamic content**  
  Captures whatever text is on your clipboard at the moment you press the button

- **Prevent Clear mode**  
  Optional lock to protect stored clips from being cleared

- **Hold to clear**  
  Press and hold for one second to clear a slot when it is not locked

- **Visual feedback**  
  Icons show whether a slot is empty, filled, or locked

- **Persistent storage**  
  Stored clips survive app restarts and profile switches

- **Manual clear option**  
  Clear a slot instantly using a button in the settings panel

## Screenshots


### Button States

| Empty | Filled | Locked (Filled) | Locked (Empty) |
|:-------:|:--------:|:----------------:|:-----------------:|
| ![Empty state](docs/images/empty.png) | ![Filled state](docs/images/filled.png) | ![Locked state](docs/images/locked.png) | ![Empty locked state](docs/images/empty-locked.png) |
| Ready to be assigned from clipboard | Displaying captured text | Protected with stored content | Protected, ready to be assigned from clipboard |

### Settings Panel
![Settings panel](docs/images/settings-panel.png)

*Settings panel with Prevent Clear checkbox and Clear Stored Content button*

### Hold-to-Clear
![Hold to clear feedback](docs/images/release-clear.png)

*Visual feedback when holding button to clear*

## Installation

### From the Stream Deck Marketplace (Pending Publication)

1. Open the Stream Deck application
2. Go to the Marketplace
3. Search for "Quick Clips"
4. Click Install

### Manual Installation (Development)

1. Clone this repository:
   ```bash
   git clone https://github.com/glmorgan/quick-clips.git
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

5. Restart Stream Deck (choose one):
   
   **Option 1:** Using CLI (requires `npm install -g @elgato/streamdeck-cli`)
   ```bash
   streamdeck restart com.quickclips.streamdeck
   ```
   
   **Option 2:** Manually quit and reopen the Stream Deck application

## How It Works

### Basic Usage

1. Add a Quick Clips button to your Stream Deck from the Actions panel
2. Click an empty button to capture the current clipboard contents
3. Click a filled button to paste the stored text into the active application
4. Press and hold for one second to clear the slot. You will see a "Release to Clear" message while holding

### Advanced Features

#### Prevent Clear (Lock Mode)

Enable this option in the button’s settings to:

- Disable the hold to clear behavior
- Show a lock icon to indicate the slot is protected
- Prevent accidental clearing of important clips

You can still clear the slot manually using the **Clear Stored Content** button in the settings.

#### Visual States

Each button updates its icon based on its current state:

| State | Icon | Description |
|------|------|-------------|
| Empty, unlocked | Gray clipboard | Ready to be assigned from clipboard |
| Empty, locked | Locked clipboard | Protected and ready to be assigned from clipboard |
| Filled, unlocked | Blue clipboard | Ready to paste; can be cleared |
| Filled, locked | Lock icon | Ready to paste; protected from being overwritten |

### Button Settings

Click on the button from Settings to:

- **Prevent Clear** checkbox to enable or disable hold to clear
- **Clear Stored Content** button to manually reset the slot

## Platform Support

- **macOS**: Supported and tested on macOS 10.15 and later
- **Windows**: Planned for a future release
- **Linux**: Planned for a future release

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

- Built with TypeScript using the Elgato Stream Deck SDK v2.0
- Uses native macOS clipboard tools (pbpaste and pbcopy)
- Settings are stored persistently within Stream Deck profiles
- No external services or network access required

## License

MIT

## Author

Glen Morgan

## Support

For bugs, feature requests, or questions, please visit the GitHub issues page:
https://github.com/glmorgan/quick-clips/issues
