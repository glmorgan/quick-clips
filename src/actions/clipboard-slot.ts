import { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent, streamDeck } from "@elgato/streamdeck";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Long press threshold in milliseconds
const LONG_PRESS_THRESHOLD = 1000;

/**
 * Quick Clip Action - A clipboard management slot for Stream Deck
 * 
 * Provides a reusable clipboard slot that captures, stores, and pastes text content.
 * Each slot instance maintains its own independent clipboard history with persistent storage.
 * 
 * @remarks
 * This action supports three primary interaction modes:
 * - **Empty State**: Click to capture current system clipboard content into the slot
 * - **Filled State**: Click to paste stored content (writes to clipboard and simulates Cmd+V)
 * - **Hold-to-Clear**: Press and hold for 1 second to clear stored content (can be disabled)
 * 
 * Visual feedback is provided through four distinct states:
 * - Empty (unlocked): Default empty clipboard icon
 * - Empty (locked): Protected empty state when prevent clear is enabled
 * - Filled (unlocked): Filled clipboard icon with content preview
 * - Filled (locked): Locked icon when prevent clear is enabled
 * 
 * @platform macOS - Uses pbpaste/pbcopy for clipboard access and osascript for paste simulation
 */
@action({ UUID: "com.glen-morgan.dynamic-copy.clipboard-slot" })
export class ClipboardSlot extends SingletonAction<SlotSettings> {
    /**
     * Tracks hold-to-clear state for each button instance on the Stream Deck.
     * 
     * Maintains per-button timers and clear mode flags to implement the hold-to-clear gesture.
     * When a button is held for {@link LONG_PRESS_THRESHOLD} milliseconds, the button enters
     * clear mode and displays "Release to Clear" feedback.
     * 
     * @private
     * @type {Map<string, {timer: NodeJS.Timeout | null, clearMode: boolean}>}
     */
    private holdTrackers = new Map<string, { timer: NodeJS.Timeout | null; clearMode: boolean }>();

    /**
     * Reads the current text content from the macOS system clipboard.
     * 
     * Uses the native `pbpaste` command-line utility to access clipboard data.
     * 
     * @private
     * @returns {Promise<string>} The current clipboard text, or empty string if read fails
     * @throws Logs error and returns empty string on clipboard access failure
     */
    private async readClipboard(): Promise<string> {
        try {
            const { stdout } = await execAsync("pbpaste");
            return stdout;
        } catch (error) {
            streamDeck.logger.error("Failed to read clipboard:", error);
            return "";
        }
    }

    /**
     * Writes text content to the macOS system clipboard.
     * 
     * Uses the native `pbcopy` command-line utility via a spawned process with piped stdin.
     * This approach ensures proper handling of large text content and special characters.
     * 
     * @private
     * @param {string} text - The text content to write to the clipboard
     * @returns {Promise<void>} Resolves when clipboard write completes successfully
     * @throws {Error} Rejects if pbcopy process fails or exits with non-zero code
     */
    private async writeClipboard(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const process = spawn("pbcopy");

            process.stdin.write(text);
            process.stdin.end();

            process.on("error", (error) => {
                streamDeck.logger.error("Failed to write clipboard:", error);
                reject(error);
            });

            process.on("close", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pbcopy exited with code ${code}`));
                }
            });
        });
    }

    /**
     * Simulates a Cmd+V keyboard shortcut to paste clipboard content into the active application.
     * 
     * Uses AppleScript via `osascript` to send a synthetic keystroke event to the system.
     * This provides seamless paste functionality without requiring user keyboard input.
     * 
     * @private
     * @returns {Promise<void>} Resolves when paste simulation completes
     * @throws Logs error if AppleScript execution fails (does not reject)
     */
    private async simulatePaste(): Promise<void> {
        try {
            // Use AppleScript to simulate Cmd+V keystroke
            await execAsync('osascript -e \'tell application "System Events" to keystroke "v" using command down\'');
        } catch (error) {
            streamDeck.logger.error("Failed to simulate paste:", error);
        }
    }

    /**
     * Generates a compact display label from clipboard text for button title.
     * 
     * Formats the text to fit Stream Deck button constraints with intelligent truncation:
     * - Maximum 7 characters per line
     * - Maximum 2 lines (14 characters total)
     * - Attempts word-boundary breaks for readability
     * - Appends ellipsis (…) when content is truncated
     * 
     * @private
     * @param {string} text - The full clipboard text to generate a label from
     * @returns {string} Formatted label string with newlines for multi-line display
     * @example
     * generateLabel("Hello World") // Returns: "Hello\nWorld"
     * generateLabel("This is a very long text") // Returns: "This is\na very…"
     */
    private generateLabel(text: string): string {
        // Remove newlines and extra whitespace for cleaner display
        const cleanText = text.replace(/\s+/g, ' ').trim();

        const maxCharsPerLine = 7;
        const maxLines = 2;
        const maxTotalChars = maxCharsPerLine * maxLines;

        if (cleanText.length <= maxCharsPerLine) {
            // Fits on one line
            return cleanText;
        } else if (cleanText.length <= maxTotalChars) {
            // Fits in 2 lines - try to break at word boundary
            let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);

            if (breakPoint === -1 || breakPoint < 3) {
                // No good word boundary, break at max chars
                breakPoint = maxCharsPerLine;
            }

            const line1 = cleanText.substring(0, breakPoint).trim();
            const line2 = cleanText.substring(breakPoint).trim();
            return `${line1}\n${line2}`;
        } else {
            // Too long - truncate to fit in 2 lines with ellipsis
            // Reserve space for ellipsis on line 2
            const line2MaxChars = maxCharsPerLine - 1; // Leave room for …

            // Find break point for line 1
            let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);
            if (breakPoint === -1 || breakPoint < 3) {
                breakPoint = maxCharsPerLine;
            }

            const line1 = cleanText.substring(0, breakPoint).trim();
            const remainingText = cleanText.substring(breakPoint).trim();

            // Truncate line 2 if needed
            let line2 = remainingText;
            if (line2.length > line2MaxChars) {
                // Try to break at word boundary
                const line2Break = line2.lastIndexOf(' ', line2MaxChars);
                if (line2Break > 3) {
                    line2 = line2.substring(0, line2Break).trim();
                } else {
                    line2 = line2.substring(0, line2MaxChars);
                }
            }

            return `${line1}\n${line2}…`;
        }
    }

    /**
     * Updates the button's visual appearance to reflect current slot state and settings.
     * 
     * Synchronizes the button's title, state, and icon based on whether the slot contains
     * stored content and whether prevent clear is enabled. Uses type guards to safely
     * access action methods across different event types.
     * 
     * @remarks
     * Visual State Matrix:
     * | Content | Prevent Clear | State | Icon          | Title         |
     * |---------|---------------|-------|---------------|---------------|
     * | Empty   | Disabled      | 0     | Default       | "Empty"       |
     * | Empty   | Enabled       | 0     | empty-locked  | "Empty"       |
     * | Filled  | Disabled      | 1     | Default       | Content label |
     * | Filled  | Enabled       | 1     | locked        | Content label |
     * 
     * @private
     * @param {WillAppearEvent | KeyDownEvent | KeyUpEvent | DidReceiveSettingsEvent | SendToPluginEvent} ev - Stream Deck event with action context
     * @param {SlotSettings} settings - Current settings containing value, label, and suppressClear
     * @returns {Promise<void>} Resolves when all display updates are complete
     */
    private async updateDisplay(
        ev: WillAppearEvent<SlotSettings> | KeyDownEvent<SlotSettings> | KeyUpEvent<SlotSettings> | DidReceiveSettingsEvent<SlotSettings> | SendToPluginEvent<any, SlotSettings>,
        settings: SlotSettings
    ): Promise<void> {
        let title: string;
        let state: number;
        let imagePath: string | undefined;

        if (settings.value) {
            title = settings.label || "Stored";
            state = 1; // Filled state

            // Use lock icon if prevent clear is enabled
            if (settings.suppressClear) {
                imagePath = "imgs/actions/clipboard/locked.png";
            }
        } else {
            title = "Empty";
            state = 0; // Empty state

            // Use empty-locked icon if prevent clear is enabled
            if (settings.suppressClear) {
                imagePath = "imgs/actions/clipboard/empty-locked.png";
            }
        }

        // All action types should have setTitle
        if ('setTitle' in ev.action && typeof ev.action.setTitle === 'function') {
            await ev.action.setTitle(title);
        }

        // setState is available on KeyAction (KeyDownEvent and KeyUpEvent have KeyAction)
        if ('setState' in ev.action && typeof ev.action.setState === 'function') {
            await ev.action.setState(state);
        }

        // Set image - either custom lock icon or undefined to reset to state's default
        if ('setImage' in ev.action && typeof ev.action.setImage === 'function') {
            await ev.action.setImage(imagePath);
        }
    }

    /**
     * Lifecycle handler called when the action appears on the Stream Deck.
     * 
     * Fetches persisted settings and initializes the button's visual state.
     * This ensures the button displays correct state information when:
     * - Stream Deck application starts
     * - User switches between profiles
     * - Action is added to a new button
     * 
     * @override
     * @param {WillAppearEvent<SlotSettings>} ev - Event containing action context and current settings
     * @returns {Promise<void>} Resolves when initialization is complete
     */
    override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
        // Always fetch fresh settings to avoid stale data
        const settings = await ev.action.getSettings();
        await this.updateDisplay(ev, settings);
    }

    /**
     * Handles messages sent from the property inspector UI to the plugin.
     * 
     * Processes custom events from the property inspector, currently supporting:
     * - `clearSlot`: Clears stored clipboard content and resets button to empty state
     * 
     * The display is manually updated after clearing since `setSettings()` calls from
     * the plugin do not trigger `onDidReceiveSettings` events.
     * 
     * @override
     * @param {SendToPluginEvent<any, SlotSettings>} ev - Event containing payload from property inspector
     * @returns {Promise<void>} Resolves when message handling is complete
     */
    override async onSendToPlugin(ev: SendToPluginEvent<any, SlotSettings>): Promise<void> {
        streamDeck.logger.info(`[onSendToPlugin] Received event: ${ev.payload.event}`);

        if (ev.payload.event === 'clearSlot') {
            const settings = await ev.action.getSettings();

            // Clear the settings
            const clearedSettings: SlotSettings = {
                ...settings,
                value: undefined,
                label: undefined
            };

            await ev.action.setSettings(clearedSettings);

            // Manually update display since setSettings won't trigger onDidReceiveSettings
            await this.updateDisplay(ev, clearedSettings);

            streamDeck.logger.info(`[onSendToPlugin] Slot cleared and display updated`);
        }
    }    /**
     * Handles settings changes made through the property inspector.
     * 
     * Called automatically by Stream Deck when user modifies settings in the property
     * inspector UI (e.g., toggling the "Prevent Clear" checkbox). Updates the button's
     * visual state to reflect the new settings, including lock icon visibility.
     * 
     * @override
     * @param {DidReceiveSettingsEvent<SlotSettings>} ev - Event containing updated settings
     * @returns {Promise<void>} Resolves when display update is complete
     */
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
        // Update display when settings change (e.g., suppressClear toggled)
        await this.updateDisplay(ev, ev.payload.settings);
    }

    /**
     * Handles button press events and initiates hold-to-clear detection.
     * 
     * Creates a timer-based tracker to detect if the user is performing a hold gesture.
     * If the prevent clear setting is enabled, creates a dummy tracker without a timer
     * to ensure proper click handling while disabling the hold-to-clear functionality.
     * 
     * When held for {@link LONG_PRESS_THRESHOLD} milliseconds without release, the button
     * enters clear mode and displays "Release to Clear" as visual feedback.
     * 
     * @override
     * @param {KeyDownEvent<SlotSettings>} ev - Event containing action context and button state
     * @returns {Promise<void>} Resolves immediately after timer setup
     */
    override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
        const contextId = ev.action.id;
        const settings = await ev.action.getSettings();

        // Clear any existing tracker
        const existing = this.holdTrackers.get(contextId);
        if (existing?.timer) {
            clearTimeout(existing.timer);
        }

        // If suppress clear is enabled, create a simple tracker without timer
        if (settings.suppressClear) {
            const tracker = {
                timer: null,
                clearMode: false
            };
            this.holdTrackers.set(contextId, tracker);
            return;
        }

        // Create hold-to-clear tracker
        const tracker = {
            timer: setTimeout(async () => {
                // Hold threshold reached - enter clear mode
                tracker.clearMode = true;
                await ev.action.setTitle("Release\nto Clear");
            }, LONG_PRESS_THRESHOLD),
            clearMode: false
        };

        this.holdTrackers.set(contextId, tracker);
    }

    /**
     * Handles button release events and executes the appropriate action.
     * 
     * Determines whether the button press was a quick click or a hold-to-clear gesture
     * based on the tracker state set during `onKeyDown`. Executes either click behavior
     * (capture/paste) or clear behavior accordingly, then cleans up the tracker.
     * 
     * @override
     * @param {KeyUpEvent<SlotSettings>} ev - Event containing action context and button state
     * @returns {Promise<void>} Resolves when action execution is complete
     */
    override async onKeyUp(ev: KeyUpEvent<SlotSettings>): Promise<void> {
        const contextId = ev.action.id;
        const tracker = this.holdTrackers.get(contextId);
        const settings = await ev.action.getSettings();

        if (!tracker) {
            return;
        }

        // Clear the timer if it exists
        if (tracker.timer) {
            clearTimeout(tracker.timer);
        }

        if (tracker.clearMode) {
            // Was held - clear the slot
            await this.handleClear(ev, settings);
        } else {
            // Was a quick click - normal action
            await this.handleClick(ev, settings);
        }

        // Clean up
        this.holdTrackers.delete(contextId);
    }

    /**
     * Executes click action behavior based on current slot state.
     * 
     * Implements state-dependent click behavior:
     * - **Empty Slot**: Captures current system clipboard content, generates a display label,
     *   and stores both in settings for future use
     * - **Filled Slot**: Writes stored content to system clipboard and simulates Cmd+V to
     *   paste into the active application
     * 
     * Both operations provide success feedback via the showOk visual indicator.
     * 
     * @private
     * @param {KeyUpEvent<SlotSettings>} ev - Event containing action context for feedback
     * @param {SlotSettings} settings - Current settings containing stored content if any
     * @returns {Promise<void>} Resolves when click action completes
     */
    private async handleClick(ev: KeyUpEvent<SlotSettings>, settings: SlotSettings): Promise<void> {
        if (settings.value) {
            // Filled state: Copy stored value to clipboard and paste
            await this.writeClipboard(settings.value);
            await this.simulatePaste();
            await ev.action.showOk();
        } else {
            // Empty state: Capture clipboard content into slot
            const clipboardText = await this.readClipboard();

            if (clipboardText) {
                // Merge with existing settings to preserve all properties
                const newSettings: SlotSettings = {
                    ...settings,
                    value: clipboardText,
                    label: this.generateLabel(clipboardText)
                };

                await ev.action.setSettings(newSettings);
                await this.updateDisplay(ev, newSettings);
                await ev.action.showOk();
            }
        }
    }

    /**
     * Executes clear action after hold-to-clear gesture is completed.
     * 
     * Removes stored clipboard content and display label from settings while preserving
     * other settings like the prevent clear flag. Updates button visual state to show
     * empty status and provides success feedback.
     * 
     * @private
     * @param {KeyUpEvent<SlotSettings>} ev - Event containing action context for updates
     * @param {SlotSettings} settings - Current settings to merge with cleared values
     * @returns {Promise<void>} Resolves when clear operation completes
     */
    private async handleClear(ev: KeyUpEvent<SlotSettings>, settings: SlotSettings): Promise<void> {
        // Clear the slot - merge with existing settings and remove value/label
        const emptySettings: SlotSettings = {
            ...settings,
            value: undefined,
            label: undefined
        };

        await ev.action.setSettings(emptySettings);
        await this.updateDisplay(ev, emptySettings);
        await ev.action.showOk();
    }
}

/**
 * Persistent settings for each Quick Clip slot instance.
 * 
 * Each button instance on the Stream Deck maintains its own independent settings object,
 * stored persistently in the Stream Deck profile. Settings survive application restarts,
 * profile switches, and plugin reloads.
 * 
 * @typedef {Object} SlotSettings
 * @property {string} [value] - The full clipboard text stored in this slot (undefined when empty)
 * @property {string} [label] - Generated display label shown on button (max 2 lines, 7 chars per line)
 * @property {boolean} [suppressClear] - When true, disables hold-to-clear functionality and shows lock icon
 */
type SlotSettings = {
    /** The stored clipboard text */
    value?: string;

    /** Display label (auto-generated from value) */
    label?: string;

    /** If true, disable hold-to-clear functionality */
    suppressClear?: boolean;
};
