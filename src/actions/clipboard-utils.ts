import { action, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, streamDeck } from "@elgato/streamdeck";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyTransform } from "../utils.js";

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
};

const TRANSFORM_GROUPS = [
    { header: '— Case —',           items: ['To Upper', 'To Lower', 'To Title', 'To Camel', 'To Snake', 'To Dash'] },
    { header: '— Encode / Decode —', items: ['B64 Encode', 'B64 Decode', 'URL Encode', 'URL Decode'] },
    { header: '— Utility —',         items: ['Trim', 'Count'] },
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
};

type UtilSettings = {
    transform?: TransformType;
    pasteMode?: 'typing' | 'clipboard';
};

@action({ UUID: "com.quickclips.streamdeck.clipboard-utils" })
export class ClipboardUtils extends SingletonAction<UtilSettings> {

    private holdTrackers = new Map<string, { timer: NodeJS.Timeout | null; configMode: boolean }>();

    private async promptTransform(): Promise<TransformType | null> {
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

    private async readClipboard(): Promise<string> {
        try {
            const { stdout } = await execAsync("pbpaste");
            return stdout;
        } catch (error) {
            streamDeck.logger.error("Failed to read clipboard:", error);
            return "";
        }
    }

    private async writeClipboard(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn("pbcopy");
            proc.stdin.write(text);
            proc.stdin.end();
            proc.on("error", reject);
            proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited with code ${code}`)));
        });
    }

    private async simulatePaste(): Promise<void> {
        try {
            await execAsync('osascript -e \'tell application "System Events" to keystroke "v" using command down\'');
        } catch (error) {
            streamDeck.logger.error("Failed to simulate paste:", error);
        }
    }

    private async simulateTyping(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const parts = text.split('"').map(p => `"${p}"`);
            const asString = parts.join(' & quote & ');
            const script = `tell application "System Events" to keystroke ${asString}`;
            const proc = spawn('osascript', ['-']);
            proc.stdin.write(script);
            proc.stdin.end();
            proc.on('error', reject);
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`osascript exited with code ${code}`)));
        });
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
            await ev.action.setSettings({ ...settings, pasteMode: 'typing' });
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
            // Hold — show picker to reconfigure transform
            const chosen = await this.promptTransform();
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

        const text = await this.readClipboard();
        if (!text) {
            await ev.action.showAlert();
            return;
        }

        if (settings.transform === 'count') {
            await this.showCount(text);
            await ev.action.showOk();
            return;
        }

        const transformed = applyTransform(text, settings.transform);
        if ((settings.pasteMode ?? 'typing') === 'typing') {
            await this.simulateTyping(transformed);
        } else {
            await this.writeClipboard(transformed);
            await this.simulatePaste();
        }
        await ev.action.showOk();
    }
}
