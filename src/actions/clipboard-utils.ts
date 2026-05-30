import { action, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, streamDeck } from "@elgato/streamdeck";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type TransformType = 'upper' | 'lower' | 'titlecase' | 'camelCase' | 'dashcase' | 'snakecase' | 'trim' | 'urlencode' | 'urldecode' | 'base64encode' | 'base64decode' | 'count';

const TRANSFORM_LABELS: Record<TransformType, string> = {
    upper: 'UPPER',
    lower: 'lower',
    titlecase: 'Title',
    camelCase: 'camel',
    dashcase: 'dash',
    snakecase: 'snake',
    trim: 'trim',
    urlencode: 'URL enc',
    urldecode: 'URL dec',
    base64encode: 'b64 enc',
    base64decode: 'b64 dec',
    count: 'count',
};

// Stub icon paths — replace with dedicated per-transform icons when assets are ready
const TRANSFORM_ICONS: Record<TransformType, string> = {
    upper: 'imgs/actions/clipboard/filled',
    lower: 'imgs/actions/clipboard/filled',
    titlecase: 'imgs/actions/clipboard/filled',
    camelCase: 'imgs/actions/clipboard/filled',
    dashcase: 'imgs/actions/clipboard/filled',
    snakecase: 'imgs/actions/clipboard/filled',
    trim: 'imgs/actions/clipboard/filled',
    urlencode: 'imgs/actions/clipboard/filled',
    urldecode: 'imgs/actions/clipboard/filled',
    base64encode: 'imgs/actions/clipboard/filled',
    base64decode: 'imgs/actions/clipboard/filled',
    count: 'imgs/actions/clipboard/filled',
};

type UtilSettings = {
    transform?: TransformType;
    pasteMode?: 'typing' | 'clipboard';
};

@action({ UUID: "com.quickclips.streamdeck.clipboard-utils" })
export class ClipboardUtils extends SingletonAction<UtilSettings> {

    private applyTransform(text: string, transform: TransformType): string {
        switch (transform) {
            case 'upper':
                return text.toUpperCase();
            case 'lower':
                return text.toLowerCase();
            case 'base64encode':
                return Buffer.from(text).toString('base64');
            case 'base64decode':
                return Buffer.from(text, 'base64').toString('utf8');
            case 'camelCase': {
                const words = text.trim().split(/[\s\-_]+/);
                return words[0].toLowerCase() + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
            }
            case 'dashcase':
                return text.trim().toLowerCase().replace(/[\s_]+/g, '-');
            case 'snakecase':
                return text.trim().toLowerCase().replace(/[\s\-]+/g, '_');
            case 'titlecase':
                return text.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
            case 'trim':
                return text.trim();
            case 'urlencode':
                return encodeURIComponent(text.trim());
            case 'urldecode':
                return decodeURIComponent(text.trim());
            case 'count':
                return text; // handled separately via showCount
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
        ev: WillAppearEvent<UtilSettings> | KeyUpEvent<UtilSettings> | DidReceiveSettingsEvent<UtilSettings>,
        settings: UtilSettings
    ): Promise<void> {
        if ('setTitle' in ev.action && typeof ev.action.setTitle === 'function') {
            await ev.action.setTitle(settings.transform ? TRANSFORM_LABELS[settings.transform] : 'Pick a\ntransform');
        }
        if ('setState' in ev.action && typeof ev.action.setState === 'function') {
            await ev.action.setState(settings.transform ? 1 : 0);
        }
        if ('setImage' in ev.action && typeof ev.action.setImage === 'function') {
            await ev.action.setImage(settings.transform ? TRANSFORM_ICONS[settings.transform] : undefined);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<UtilSettings>): Promise<void> {
        const settings = await ev.action.getSettings();
        if (settings.pasteMode === undefined) {
            await ev.action.setSettings({ ...settings, pasteMode: 'typing' });
        }
        await this.updateDisplay(ev, settings);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UtilSettings>): Promise<void> {
        await this.updateDisplay(ev, ev.payload.settings);
    }

    override async onKeyUp(ev: KeyUpEvent<UtilSettings>): Promise<void> {
        const settings = await ev.action.getSettings();

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

        const transformed = this.applyTransform(text, settings.transform);

        if ((settings.pasteMode ?? 'typing') === 'typing') {
            await this.simulateTyping(transformed);
        } else {
            await this.writeClipboard(transformed);
            await this.simulatePaste();
        }
        await ev.action.showOk();
    }
}
