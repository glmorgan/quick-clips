import { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, streamDeck } from "@elgato/streamdeck";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyTransform, isGenerator } from "../utils.js";
import { outputText, readClipboard, type PasteMode } from "../typing.js";
import { findHosts, showPicker, type PickerItem } from "../picker.js";

const execAsync = promisify(exec);

export type { TransformType } from "../utils.js";
import type { TransformType } from "../utils.js";

const LONG_PRESS_THRESHOLD = 1000;

const TRANSFORM_LABELS: Record<TransformType, string> = {
    upper: 'To Upper',
    lower: 'To Lower',
    titlecase: 'To Title',
    camelCase: 'To Camel',
    dashcase: 'To Dash',
    snakecase: 'To Snake',
    trim: 'Trim',
    urlencode: 'URL Enc',
    urldecode: 'URL Dec',
    base64encode: 'B64 Enc',
    base64decode: 'B64 Dec',
    count: 'Count',
    uuid: 'UUID',
    dateiso: 'Date',
    datetimeiso: 'Date Time',
    unixtime: 'Unix (s)',
    unixtimems: 'Unix (ms)',
};

const TRANSFORM_ICONS: Record<TransformType, string> = {
    upper: 'imgs/actions/utils/upper',
    lower: 'imgs/actions/utils/lower',
    titlecase: 'imgs/actions/utils/titlecase',
    camelCase: 'imgs/actions/utils/camelcase',
    dashcase: 'imgs/actions/utils/dashcase',
    snakecase: 'imgs/actions/utils/snakecase',
    trim: 'imgs/actions/utils/trim',
    urlencode: 'imgs/actions/utils/urlencode',
    urldecode: 'imgs/actions/utils/urldecode',
    base64encode: 'imgs/actions/utils/base64encode',
    base64decode: 'imgs/actions/utils/base64decode',
    count: 'imgs/actions/utils/count',
    uuid: 'imgs/actions/utils/uuid',
    dateiso: 'imgs/actions/utils/dateiso',
    datetimeiso: 'imgs/actions/utils/datetimeiso',
    unixtime: 'imgs/actions/utils/unixtime',
    unixtimems: 'imgs/actions/utils/unixtimems',
};

const TRANSFORM_GROUPS = [
    { header: '— Case —',           items: ['To Upper', 'To Lower', 'To Title', 'To Camel', 'To Snake', 'To Dash'] },
    { header: '— Encode / Decode —', items: ['B64 Encode', 'B64 Decode', 'URL Encode', 'URL Decode'] },
    { header: '— Utility —',         items: ['Trim', 'Count'] },
    { header: '— Generate —',        items: ['Date', 'Date & Time', 'Unix Time (s)', 'Unix Time (ms)', 'UUID'] },
];

const TRANSFORM_LIST = TRANSFORM_GROUPS.flatMap(g => [g.header, ...g.items.map(i => `  ${i}`)]);

const LABEL_TO_TRANSFORM: Record<string, TransformType> = {
    'To Upper': 'upper',
    'To Lower': 'lower',
    'To Title': 'titlecase',
    'To Camel': 'camelCase',
    'To Dash': 'dashcase',
    'To Snake': 'snakecase',
    'Trim': 'trim',
    'URL Encode': 'urlencode',
    'URL Decode': 'urldecode',
    'B64 Encode': 'base64encode',
    'B64 Decode': 'base64decode',
    'Count': 'count',
    'UUID': 'uuid',
    'Date': 'dateiso',
    'Date & Time': 'datetimeiso',
    'Unix Time (s)': 'unixtime',
    'Unix Time (ms)': 'unixtimems',
};

/**
 * Grouping for the rich browser picker. Unlike {@link TRANSFORM_GROUPS} (which flattens
 * headers into selectable rows because `choose from list` has no section concept), this
 * references transforms by id, so no display-string round-trip is involved.
 */
const PICKER_GROUPS: { group: string; items: TransformType[] }[] = [
    { group: 'Case', items: ['upper', 'lower', 'titlecase', 'camelCase', 'snakecase', 'dashcase'] },
    { group: 'Encode / Decode', items: ['base64encode', 'base64decode', 'urlencode', 'urldecode'] },
    { group: 'Utility', items: ['trim', 'count'] },
    { group: 'Generate', items: ['dateiso', 'datetimeiso', 'unixtime', 'unixtimems', 'uuid'] },
];

/**
 * Full names for the picker, which has room for more than the button title does.
 *
 * The case transforms are written *in* the case they produce, so the label doubles as a
 * worked example — `to_snake_case` shows the output shape faster than any description.
 * The remaining transforms can't self-demonstrate legibly, so they stay plain.
 */
const TRANSFORM_FULL_NAMES: Record<TransformType, string> = {
    upper: 'TO UPPER',
    lower: 'to lower',
    titlecase: 'To Title Case',
    camelCase: 'toCamelCase',
    dashcase: 'to-dash-case',
    snakecase: 'to_snake_case',
    trim: 'Trim Whitespace',
    urlencode: 'URL Encode',
    urldecode: 'URL Decode',
    base64encode: 'Base64 Encode',
    base64decode: 'Base64 Decode',
    count: 'Word Count',
    uuid: 'UUID',
    dateiso: 'Date',
    datetimeiso: 'Date & Time',
    unixtime: 'Unix Time (s)',
    unixtimems: 'Unix Time (ms)',
};

/**
 * Tint used for each transform's icon tile in the picker. These mirror the accent bar
 * baked into the corresponding PNG — update both together if the icons are redrawn.
 */
const TRANSFORM_ACCENTS: Record<TransformType, string> = {
    upper: '#ffd966',
    lower: '#ffd966',
    titlecase: '#ffd966',
    camelCase: '#ffd966',
    dashcase: '#ffd966',
    snakecase: '#ffd966',
    base64encode: '#93c47d',
    base64decode: '#93c47d',
    urlencode: '#ad7dc4',
    urldecode: '#ad7dc4',
    trim: '#cc0000',
    count: '#e69138',
    // Generators share one accent, the same way the case and encoding families do
    uuid: '#6d9eeb',
    dateiso: '#6d9eeb',
    datetimeiso: '#6d9eeb',
    unixtime: '#6d9eeb',
    unixtimems: '#6d9eeb',
};

function buildPickerItems(): PickerItem[] {
    return PICKER_GROUPS.flatMap(({ group, items }) =>
        items.map(id => ({
            id,
            group,
            label: TRANSFORM_FULL_NAMES[id],
            icon: TRANSFORM_ICONS[id],
            accent: TRANSFORM_ACCENTS[id],
        }))
    );
}

type UtilSettings = {
    transform?: TransformType;
    pasteMode?: PasteMode;
};

@action({ UUID: "com.quickclips.streamdeck.clipboard-utils" })
export class ClipboardUtils extends SingletonAction<UtilSettings> {

    private holdTrackers = new Map<string, { timer: NodeJS.Timeout | null; configMode: boolean }>();

    /** Buttons whose transform picker is on screen; see ClipboardManager.open for why. */
    private open = new Set<string>();

    /**
     * Shows the transform picker, trying each available window host in turn (native, then any
     * Chromium-family browser) and falling back to the osascript list if none can display.
     * The fallback keeps the action fully functional on a bare machine.
     */
    private async promptTransform(current?: TransformType): Promise<TransformType | null> {
        // Work down the available hosts. A host can exist yet fail to launch — an unsigned native
        // host that Gatekeeper quarantined is the usual cause — so a failure here must try the
        // next one rather than be mistaken for the user cancelling.
        for (const host of await findHosts()) {
            try {
                const chosen = await showPicker(buildPickerItems(), host, {
                    title: 'Quick Text Utils',
                    subtitle: 'Pick what this button should do',
                    filterPlaceholder: 'Filter transforms…',
                    selectedId: current,
                    onWarn: message => streamDeck.logger.warn(message),
                });
                return chosen as TransformType | null;
            } catch (error) {
                streamDeck.logger.warn(`Picker host unavailable, trying the next one:`, error);
            }
        }
        streamDeck.logger.info("No window host available; using the osascript picker");
        return this.promptTransformViaOsascript();
    }

    private async promptTransformViaOsascript(): Promise<TransformType | null> {
        const listStr = TRANSFORM_LIST.map(t => `"${t}"`).join(', ');
        const script = `set choices to {${listStr}}
set chosen to choose from list choices with prompt "Choose transform:" without multiple selections allowed
if chosen is false then return ""
return item 1 of chosen`;
        const tmpFile = join(tmpdir(), `quickutils-${Date.now()}.applescript`);
        try {
            await writeFile(tmpFile, script);
            const { stdout } = await execAsync(`osascript "${tmpFile}"`);
            const chosen = stdout.trim();
            return chosen ? (LABEL_TO_TRANSFORM[chosen.trim()] ?? null) : null;
        } catch (error) {
            streamDeck.logger.error("promptTransform failed:", error);
            return null;
        } finally {
            await unlink(tmpFile).catch(() => {});
        }
    }

    private async showCount(text: string): Promise<void> {
        const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
        const chars = text.length;
        const charsNoSpaces = text.replace(/\s/g, '').length;
        const lines = text.split(/\r?\n/).length;
        const message = `Words: ${words}\\nCharacters: ${chars}\\nCharacters (no spaces): ${charsNoSpaces}\\nLines: ${lines}`;
        await execAsync(`osascript -e 'display dialog "${message}" buttons {"OK"} default button "OK" with title "Word Count"'`);
    }





    private async updateDisplay(
        ev: WillAppearEvent<UtilSettings> | KeyDownEvent<UtilSettings> | KeyUpEvent<UtilSettings> | DidReceiveSettingsEvent<UtilSettings>,
        settings: UtilSettings
    ): Promise<void> {
        if ('setTitle' in ev.action && typeof ev.action.setTitle === 'function') {
            await ev.action.setTitle(settings.transform ? TRANSFORM_LABELS[settings.transform] : 'Configure');
        }
        if ('setState' in ev.action && typeof ev.action.setState === 'function') {
            await ev.action.setState(settings.transform ? 1 : 0);
        }
        if ('setImage' in ev.action && typeof ev.action.setImage === 'function') {
            await ev.action.setImage(settings.transform ? TRANSFORM_ICONS[settings.transform] : 'imgs/actions/utils/empty');
        }
    }

    override async onWillAppear(ev: WillAppearEvent<UtilSettings>): Promise<void> {
        const settings = await ev.action.getSettings();
        if (settings.pasteMode === undefined) {
            await ev.action.setSettings({ ...settings, pasteMode: 'auto' });
        }
        await this.updateDisplay(ev, settings);
    }

    override onWillDisappear(ev: WillDisappearEvent<UtilSettings>): void {
        const tracker = this.holdTrackers.get(ev.action.id);
        if (tracker?.timer) clearTimeout(tracker.timer);
        this.holdTrackers.delete(ev.action.id);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UtilSettings>): Promise<void> {
        await this.updateDisplay(ev, ev.payload.settings);
    }

    override async onKeyDown(ev: KeyDownEvent<UtilSettings>): Promise<void> {
        const existing = this.holdTrackers.get(ev.action.id);
        if (existing?.timer) clearTimeout(existing.timer);

        const tracker = {
            timer: setTimeout(async () => {
                tracker.configMode = true;
                await ev.action.setTitle("");
                await ev.action.setImage("imgs/actions/utils/configure");
            }, LONG_PRESS_THRESHOLD),
            configMode: false
        };
        this.holdTrackers.set(ev.action.id, tracker);
    }

    override async onKeyUp(ev: KeyUpEvent<UtilSettings>): Promise<void> {
        const tracker = this.holdTrackers.get(ev.action.id);
        const settings = await ev.action.getSettings();

        if (tracker?.timer) clearTimeout(tracker.timer);
        this.holdTrackers.delete(ev.action.id);

        if (tracker?.configMode) {
            // Hold — show picker to reconfigure transform. The picker is pure configuration,
            // so it never touches the clipboard.
            if (this.open.has(ev.action.id)) {
                streamDeck.logger.info("Picker already open for this button; ignoring the press");
                return;
            }
            this.open.add(ev.action.id);
            let chosen: TransformType | null;
            try {
                chosen = await this.promptTransform(settings.transform);
            } finally {
                this.open.delete(ev.action.id);
            }
            if (chosen) {
                const newSettings: UtilSettings = { ...settings, transform: chosen };
                await ev.action.setSettings(newSettings);
                await this.updateDisplay(ev, newSettings);
            } else {
                // Cancelled — restore display
                await this.updateDisplay(ev, settings);
            }
            return;
        }

        // Short press — apply transform
        if (!settings.transform) {
            await ev.action.showAlert();
            return;
        }

        // Generators produce their own value, so an empty clipboard is not an error for them
        const needsClipboard = !isGenerator(settings.transform);
        const text = needsClipboard ? await readClipboard() : '';
        if (needsClipboard && !text) {
            await ev.action.showAlert();
            return;
        }

        if (settings.transform === 'count') {
            await this.showCount(text);
            await ev.action.showOk();
            return;
        }

        const transformed = applyTransform(text, settings.transform);
        try {
            await outputText(transformed, settings.pasteMode,
                m => streamDeck.logger.warn(m));
        } catch (error) {
            streamDeck.logger.error("Failed to output text:", error);
            await ev.action.showAlert();
            return;
        }
        await ev.action.showOk();
    }
}
