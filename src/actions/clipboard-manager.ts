import {
    action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent,
    DidReceiveSettingsEvent, SendToPluginEvent, streamDeck,
} from "@elgato/streamdeck";
import { randomUUID } from "node:crypto";
import {
    addClip, clipRowText, clipSearchText, detectClipKind, promoteClip, removeClip, renameClip,
    restoreClip, toggleClipHidden, type ClipEntry, type ClipKind,
} from "../utils.js";
import { findHosts, showPicker, type PickerItem } from "../picker.js";
import { outputText, readClipboard } from "../typing.js";

/** Id of the picker row that captures the current clipboard. Not a clip id. */
const ADD_ACTION = "add-from-clipboard";

/** Hold duration that turns a press into a capture. Matches the other two actions. */
const LONG_PRESS_THRESHOLD = 1000;

/**
 * Badge shown for each detected clip shape. Colours reuse the palette the transform icons
 * already use, so URL clips read the same purple as the URL transforms.
 */
const KIND_BADGES: Record<ClipKind, { text: string; accent: string; search: string }> = {
    // `search` carries synonyms so the filter is forgiving about what a kind is called —
    // "colour" and "hex" both find swatches, "token" finds JWTs. These are matched but never
    // shown, which is what lets a swatch be searchable despite displaying no text.
    json: { text: "JSON", accent: "#93c47d", search: "json data object" },
    url: { text: "URL", accent: "#ad7dc4", search: "url link http web" },
    path: { text: "Path", accent: "#6d9eeb", search: "path file folder directory" },
    email: { text: "Email", accent: "#e69138", search: "email address mail" },
    uuid: { text: "UUID", accent: "#76a5af", search: "uuid guid id identifier" },
    jwt: { text: "JWT", accent: "#a64d79", search: "jwt token bearer auth" },
    color: { text: "Color", accent: "#c27ba0", search: "color colour hex swatch" },
    ip: { text: "IP", accent: "#45818e", search: "ip address host network" },
    date: { text: "Date", accent: "#bf9000", search: "date time timestamp iso" },
    text: { text: "Text", accent: "#8b8b93", search: "text plain" },
};

/**
 * Badge for a clip. A detected colour renders as the colour itself rather than the word
 * "Color" — the one kind where the value carries more information than its name.
 */
function buildBadge(value: string): { text: string; accent: string; search: string; swatch?: string } {
    const kind = detectClipKind(value);
    return kind === "color"
        ? { ...KIND_BADGES.color, swatch: value.trim() }
        : KIND_BADGES[kind];
}

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
 * whatever is currently on the clipboard. A hold captures it directly, without the window —
 * the same operation the picker's action row performs, for the common case where you have just
 * copied something and only want it filed.
 *
 * @platform macOS — pbpaste/pbcopy for clipboard access, osascript to type or paste.
 */
@action({ UUID: "com.quickclips.streamdeck.clipboard-manager" })
export class ClipboardManager extends SingletonAction<ManagerSettings> {
    /**
     * Buttons whose picker is currently on screen.
     *
     * Each press otherwise spawns its own window host and local server, so holding or repeatedly
     * tapping a key stacks up windows that all mutate the same collection. Keyed by action id so
     * two different collection buttons can still each open their own.
     */
    private open = new Set<string>();

    /**
     * Per-button hold state, mirroring the other two actions: the timer marks the gesture as a
     * hold and the work happens on release, so the key can show what releasing will do.
     */
    private holdTrackers = new Map<string, { timer: NodeJS.Timeout | null; captureMode: boolean }>();

    private toPickerItems(clips: ClipEntry[]): PickerItem[] {
        return clips.map(clip => {
            const row = clipRowText(clip);
            return {
            id: clip.id,
            group: "Clips",
            // Derived at render time rather than read from the stored label, so the row uses
            // whatever width the window has instead of a cap fixed when the clip was captured.
            // A URL with no user title shows its host as the name and the path beside it.
            label: row.label,
            preview: row.detail,
            title: clip.title,
            hidden: clip.hidden,
            // Name plus value, except for hidden clips where the value is deliberately omitted —
            // matching on it would highlight the row as you typed the secret.
            search: `${row.label} ${clipSearchText(clip)}`,
            badge: buildBadge(clip.value),
            // No icon: stored text has no artwork, and the picker renders the row without one.
            };
        });
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
        // Drops any image the hold gesture put there, so the key goes back to its state artwork.
        // Done here rather than only on the capture path because every route out of a hold ends
        // in updateDisplay, and a stuck override would otherwise survive until the key reappears.
        if ("setImage" in ev.action && typeof ev.action.setImage === "function") {
            await ev.action.setImage();
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

    override async onKeyDown(ev: KeyDownEvent<ManagerSettings>): Promise<void> {
        const contextId = ev.action.id;
        // Nothing to arm while the picker owns this button: the release is ignored either way,
        // and arming would flash the hold prompt onto the key for no reason.
        if (this.open.has(contextId)) return;
        const existing = this.holdTrackers.get(contextId);
        if (existing?.timer) clearTimeout(existing.timer);

        const tracker = {
            timer: setTimeout(async () => {
                tracker.captureMode = true;
                // Both the title and the image change. The title alone was not enough: it is two
                // lines of small text that only show for however long the key is held past the
                // threshold, which is easy to miss entirely when the icon stays put. Unlike
                // hold-to-clear on a Quick Clip there is nothing to lose by following through,
                // so this reads as a label rather than a warning.
                await ev.action.setTitle("Release\nto Add");
                await ev.action.setImage("imgs/actions/manager/release-to-add.png");
                streamDeck.logger.info("Hold threshold reached; releasing will capture");
            }, LONG_PRESS_THRESHOLD),
            captureMode: false,
        };
        this.holdTrackers.set(contextId, tracker);
    }

    override onWillDisappear(ev: WillDisappearEvent<ManagerSettings>): void {
        const tracker = this.holdTrackers.get(ev.action.id);
        if (tracker?.timer) clearTimeout(tracker.timer);
        this.holdTrackers.delete(ev.action.id);
    }

    override async onKeyUp(ev: KeyUpEvent<ManagerSettings>): Promise<void> {
        const contextId = ev.action.id;
        const tracker = this.holdTrackers.get(contextId);
        this.holdTrackers.delete(contextId);
        if (tracker?.timer) clearTimeout(tracker.timer);

        if (this.open.has(contextId)) {
            // Already showing for this button. This guards the hold as well as the press: the
            // open picker holds the collection in a closure and writes it back on its next
            // mutation, so a capture from the key would be silently clobbered.
            streamDeck.logger.info("Picker already open for this button; ignoring the press");
            // The hold may have replaced the title with its prompt; put the real one back.
            if (tracker?.captureMode) await this.updateDisplay(ev, await ev.action.getSettings());
            return;
        }

        if (tracker?.captureMode) {
            await this.captureFromKey(ev);
            return;
        }

        this.open.add(contextId);
        try {
            await this.handleKeyUp(ev);
        } finally {
            this.open.delete(contextId);
        }
    }

    /**
     * Hold-to-add: stores the clipboard without opening the picker.
     *
     * Deliberately not suppressible the way hold-to-clear is on a Quick Clip. That setting exists
     * because an accidental clear destroys the only copy of something; an accidental capture just
     * files one clip too many, which the picker can undo in a click.
     */
    private async captureFromKey(ev: KeyUpEvent<ManagerSettings>): Promise<void> {
        const settings = await ev.action.getSettings();
        const text = await readClipboard().catch(() => "");
        const result = addClip(settings.clips ?? [], text, randomUUID(), Date.now());

        if (!result.added) {
            streamDeck.logger.warn(`Hold-to-add refused the clipboard: ${result.reason}`);
            // Restored before the alert, so the key does not sit on the hold prompt afterwards.
            await this.updateDisplay(ev, settings);
            await ev.action.showAlert();
            return;
        }

        const updated: ManagerSettings = { ...settings, clips: result.clips };
        await ev.action.setSettings(updated);
        // setSettings from the plugin side does not raise onDidReceiveSettings.
        await this.updateDisplay(ev, updated);
        // The count on the key going up is the confirmation; this is the acknowledgement that
        // the press landed at all, since nothing else opens.
        await ev.action.showOk();
    }

    private async handleKeyUp(ev: KeyUpEvent<ManagerSettings>): Promise<void> {
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

        // A getter, not the array: `pick` runs for the lifetime of the window and every add or
        // delete replaces the list, so anything captured by value goes stale after the first
        // mutation — which made a second add overwrite the first.
        const chosenId = await this.pick(() => clips, settings, persist);
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
        getClips: () => ClipEntry[],
        settings: ManagerSettings,
        persist: (next: ClipEntry[]) => Promise<void>
    ): Promise<string | null> {
        const title = settings.name?.trim() || "Quick Clips Manager";

        /**
         * The last deletion, so it can be taken back.
         *
         * Deliberately only for the life of this window, and never written to settings: deleting
         * is one click on a small target with no confirmation, and undo exists to take back a
         * misaimed one. Persisting it would make this a trash can — somewhere clips you meant to
         * destroy quietly linger, which is the opposite of what someone masking a secret wants.
         */
        let lastDeleted: { clip: ClipEntry; index: number } | null = null;

        const onAction = async (actionId: string): Promise<PickerItem[]> => {
            if (actionId !== ADD_ACTION) return this.toPickerItems(getClips());
            const text = await readClipboard().catch(() => "");
            // Read through the getter every time, so successive adds build on each other.
            const result = addClip(getClips(), text, randomUUID(), Date.now());
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
                return await showPicker(this.toPickerItems(getClips()), host, {
                    title,
                    subtitle: getClips().length ? "Pick a clip to paste" : "This collection is empty",
                    // Stored text is long; full-width rows keep it readable.
                    layout: "list",
                    // Narrower than the transform grid: most clips are short, so the extra width
                    // was mostly trailing whitespace. Long values still ellipsise gracefully.
                    width: 720,
                    filterPlaceholder: "Filter clips…",
                    actions: [{
                        id: ADD_ACTION,
                        label: "Add from clipboard",
                        hint: "Store whatever is currently copied",
                    }],
                    onAction,
                    onToggleHidden: async (clipId: string) => {
                        await persist(toggleClipHidden(getClips(), clipId));
                        return this.toPickerItems(getClips());
                    },
                    onRename: async (clipId: string, newTitle: string) => {
                        await persist(renameClip(getClips(), clipId, newTitle));
                        return this.toPickerItems(getClips());
                    },
                    onDelete: async (clipId: string) => {
                        // Position captured too, so undo puts the clip back where it was rather
                        // than at the top, which would reorder a list ordered by use.
                        const before = getClips();
                        const index = before.findIndex(c => c.id === clipId);
                        await persist(removeClip(before, clipId));
                        lastDeleted = index === -1 ? null : { clip: before[index], index };
                        return this.toPickerItems(getClips());
                    },
                    onUndoDelete: async () => {
                        if (!lastDeleted) throw new Error("Nothing to undo");
                        const result = restoreClip(getClips(), lastDeleted.clip, lastDeleted.index);
                        if (!result.restored) {
                            // "full" is fixable, so the offer stays live for a retry once there is
                            // room. "duplicate" never becomes possible and nothing was lost, so it
                            // is dropped and a retry reports that there is nothing left to undo.
                            if (result.reason === "duplicate") lastDeleted = null;
                            throw new Error(result.reason === "full"
                                ? "Collection is full — delete something first"
                                : "That clip is already in the collection");
                        }
                        lastDeleted = null;
                        await persist(result.clips);
                        return this.toPickerItems(getClips());
                    },
                    // Browsing and tidying a collection takes longer than picking a transform,
                    // and reading a clip counts as no interaction at all.
                    timeoutMs: 180_000,
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
