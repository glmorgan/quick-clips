import { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent, streamDeck } from "@elgato/streamdeck";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Long press threshold in milliseconds
const LONG_PRESS_THRESHOLD = 1000;

/**
 * Clipboard Slot Action
 * 
 * A reusable slot that can store and restore clipboard text.
 * 
 * State Transitions:
 * 1. Empty state → Click: capture current clipboard content into slot
 * 2. Filled state → Quick click: paste stored value
 * 3. Any state → Hold for 1 second then release: clear slot
 * 
 * Hold-to-clear Detection:
 * - On keyDown: start a timer (1000ms)
 * - If timer completes: mark as hold-to-clear mode, show "Release to Clear"
 * - On keyUp: if in hold-to-clear mode, clear; otherwise execute normal click
 */
@action({ UUID: "com.glen-morgan.dynamic-copy.clipboard-slot" })
export class ClipboardSlot extends SingletonAction<SlotSettings> {
    /**
     * Map to track hold-to-clear timers per action context
     * Key: action context ID
     * Value: { timer, clearMode }
     */
    private holdTrackers = new Map<string, { timer: NodeJS.Timeout | null; clearMode: boolean }>();

    /**
     * Read text from macOS clipboard using pbpaste
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
     * Write text to macOS clipboard using pbcopy
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
     * Simulate Cmd+V paste using osascript
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
     * Generate a display label from clipboard text
     * - Max 7 characters per line
     * - Max 2 lines
     * - Try to break at word boundaries
     * - Add ellipsis if truncated
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
     * Update the button's visual appearance based on current state
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
     * Initialize visual state when action appears on Stream Deck
     */
    override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
        // Always fetch fresh settings to avoid stale data
        const settings = await ev.action.getSettings();
        await this.updateDisplay(ev, settings);
    }

    /**
     * Handle messages from property inspector
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
     * Handle settings changes from property inspector
     */
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
        // Update display when settings change (e.g., suppressClear toggled)
        await this.updateDisplay(ev, ev.payload.settings);
    }

    /**
     * Handle keyDown event - start hold-to-clear timer
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
     * Handle keyUp event - process click or clear
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
     * Handle normal click behavior
     * 
     * - Empty state: capture current clipboard into slot
     * - Filled state: paste stored value
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
     * Handle clear action (from hold-to-clear)
     * 
     * - Clears the slot and returns to empty state
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
 * Settings for Clipboard Slot action
 * 
 * Persisted per-key using Stream Deck's settings API
 */
type SlotSettings = {
    /** The stored clipboard text */
    value?: string;

    /** Display label (auto-generated from value) */
    label?: string;

    /** If true, disable hold-to-clear functionality */
    suppressClear?: boolean;
};
