import {
    action, KeyUpEvent, SingletonAction, WillAppearEvent,
    DidReceiveSettingsEvent, SendToPluginEvent, streamDeck,
} from "@elgato/streamdeck";
import { randomUUID } from "node:crypto";
import { addClip, promoteClip, type ClipEntry } from "../utils.js";
import { findHosts, showPicker, type PickerItem } from "../picker.js";
import { outputText, readClipboard } from "../typing.js";

/** Id of the picker row that captures the current clipboard. Not a clip id. */
const ADD_ACTION = "add-from-clipboard";

type ManagerSettings = {
    /** Collection name, shown on the key and as the picker heading. */
    name?: string;
    clips?: ClipEntry[];
    pasteMode?: "typing" | "clipboard";
};

/**
 * Quick Clips Manager — a keyed collection of reusable snippets.
 *
 * Where a Quick Clip holds exactly one value per key, this holds many behind one key and uses
 * the picker to choose between them. That trades instant pasting for capacity: it suits the
 * long tail of per-project details, while frequently pasted values still belong on their own
 * Quick Clip keys.
 *
 * A short press opens the picker, which both lists the collection and offers to capture
 * whatever is currently on the clipboard. There is deliberately no hold gesture.
 *
 * @platform macOS — pbpaste/pbcopy for clipboard access, osascript to type or paste.
 */
@action({ UUID: "com.quickclips.streamdeck.clipboard-manager" })
export class ClipboardManager extends SingletonAction<ManagerSettings> {





    private toPickerItems(clips: ClipEntry[]): PickerItem[] {
        return clips.map(clip => ({
            id: clip.id,
            group: "Clips",
            label: clip.label,
            // No icon: stored text has no artwork, and the picker renders the row without one.
        }));
    }

    private async updateDisplay(
        ev: WillAppearEvent<ManagerSettings> | KeyUpEvent<ManagerSettings>
            | DidReceiveSettingsEvent<ManagerSettings> | SendToPluginEvent<any, ManagerSettings>,
        settings: ManagerSettings
    ): Promise<void> {
        const count = settings.clips?.length ?? 0;
        const name = settings.name?.trim();
        if ("setTitle" in ev.action && typeof ev.action.setTitle === "function") {
            // Second line carries the count so a glance shows whether a collection has anything.
            await ev.action.setTitle(name ? `${name}\n${count}` : (count ? `${count} clips` : "Empty"));
        }
        if ("setState" in ev.action && typeof ev.action.setState === "function") {
            await ev.action.setState(count > 0 ? 1 : 0);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<ManagerSettings>): Promise<void> {
        const settings = await ev.action.getSettings();
        if (settings.pasteMode === undefined) {
            await ev.action.setSettings({ ...settings, pasteMode: "typing" });
        }
        await this.updateDisplay(ev, settings);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ManagerSettings>): Promise<void> {
        await this.updateDisplay(ev, ev.payload.settings);
    }

    /** Property inspector "Clear Collection" button. */
    override async onSendToPlugin(ev: SendToPluginEvent<any, ManagerSettings>): Promise<void> {
        if (ev.payload?.event !== "clearCollection") return;
        const settings = await ev.action.getSettings();
        const cleared: ManagerSettings = { ...settings, clips: [] };
        await ev.action.setSettings(cleared);
        // setSettings from the plugin side does not raise onDidReceiveSettings.
        await this.updateDisplay(ev, cleared);
    }

    override async onKeyUp(ev: KeyUpEvent<ManagerSettings>): Promise<void> {
        const settings = await ev.action.getSettings();
        // Held in a local rather than re-read per action, so the picker and the final paste
        // agree on one list even though the picker mutates it while open.
        let clips = settings.clips ?? [];

        const persist = async (next: ClipEntry[]): Promise<void> => {
            clips = next;
            const updated: ManagerSettings = { ...settings, clips: next };
            await ev.action.setSettings(updated);
            await this.updateDisplay(ev, updated);
        };

        const chosenId = await this.pick(clips, settings, persist);
        if (!chosenId) return;

        const clip = clips.find(c => c.id === chosenId);
        if (!clip) {
            await ev.action.showAlert();
            return;
        }

        // Most-recently-used ordering, so what gets used keeps floating up without a pinning UI.
        await persist(promoteClip(clips, clip.id));

        try {
            await outputText(clip.value, settings.pasteMode ?? "typing",
                m => streamDeck.logger.warn(m));
        } catch (error) {
            streamDeck.logger.error("Failed to output clip:", error);
            await ev.action.showAlert();
            return;
        }
        await ev.action.showOk();
    }

    /**
     * Shows the picker, working down the available window hosts. Returns the chosen clip id,
     * or null when cancelled or when no host could display.
     */
    private async pick(
        clips: ClipEntry[],
        settings: ManagerSettings,
        persist: (next: ClipEntry[]) => Promise<void>
    ): Promise<string | null> {
        const title = settings.name?.trim() || "Quick Clips Manager";

        const onAction = async (actionId: string): Promise<PickerItem[]> => {
            if (actionId !== ADD_ACTION) return this.toPickerItems(clips);
            const text = await readClipboard().catch(() => "");
            const result = addClip(clips, text, randomUUID(), Date.now());
            if (!result.added) {
                // Surfaced in the picker window rather than thrown away, so the user learns why.
                throw new Error(result.reason === "empty"
                    ? "Clipboard is empty"
                    : "Clipboard text is too long to store");
            }
            await persist(result.clips);
            return this.toPickerItems(result.clips);
        };

        for (const host of await findHosts()) {
            try {
                return await showPicker(this.toPickerItems(clips), host, {
                    title,
                    subtitle: clips.length ? "Pick a clip to paste" : "This collection is empty",
                    // Stored text is long; full-width rows keep it readable.
                    layout: "list",
                    filterPlaceholder: "Filter clips…",
                    actions: [{
                        id: ADD_ACTION,
                        label: "Add from clipboard",
                        hint: "Store whatever is currently copied",
                    }],
                    onAction,
                    // A selection is pasted immediately, so the window must be gone and focus
                    // back on the target app before we send any keystrokes.
                    awaitFocusHandoff: true,
                    onWarn: message => streamDeck.logger.warn(message),
                });
            } catch (error) {
                streamDeck.logger.warn("Picker host unavailable, trying the next one:", error);
            }
        }
        // No osascript fallback here: `choose from list` cannot offer an "add" row, so a
        // collection would be unusable rather than merely plainer.
        streamDeck.logger.error("No window host available; the clip picker cannot be shown");
        return null;
    }
}
