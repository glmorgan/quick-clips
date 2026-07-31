import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, chmod } from "node:fs/promises";
import { escapeForAppleScript } from "./utils.js";

const execAsync = promisify(exec);

/**
 * Emitting stored text into whatever app is frontmost.
 *
 * Shared by all three actions. Previously each one carried its own copy of this logic, which is
 * how the AppleScript backslash bug came to exist in two places at once.
 *
 * Typing uses one of three mechanisms, best first:
 *
 *  1. the bundled native helper, which posts Unicode directly and is exact
 *  2. AppleScript `keystroke`, but only for *printable* ASCII — it synthesises presses against
 *     the current keyboard layout, so anything else corrupts silently: non-ASCII becomes "a",
 *     newlines vanish, and tabs move focus so the rest lands in the wrong field
 *  3. borrowing the clipboard: copy, paste, restore. Exact, at the cost of momentarily
 *     overwriting the pasteboard
 *
 * Silently wrong output is worse than a briefly borrowed clipboard, hence (3) over (2) for
 * non-ASCII text when the helper is unavailable.
 */

/** Native helper, relative to the sdPlugin root. Absent unless `npm run build:native` has run. */
const NATIVE_HELPER = "bin/picker-host";

/** How long to let a paste land before restoring the previous clipboard contents. */
const PASTE_SETTLE_MS = 220;

/**
 * Environment for `pbpaste`/`pbcopy`, forcing UTF-8.
 *
 * Both transcode using the process's CoreFoundation text encoding rather than assuming UTF-8.
 * The Stream Deck plugin inherits `__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x52` — encoding 0x0, not
 * UTF-8 — so every non-ASCII character was replaced with U+FFFD at capture time. The clip was
 * therefore already corrupt in settings, and pasting faithfully reproduced the corruption,
 * which made it look like a typing bug.
 *
 * Reproduced directly: `env -i pbpaste` mangles the text, and adding LC_ALL fixes it even with
 * the broken __CF_USER_TEXT_ENCODING still set.
 */
const CLIPBOARD_ENV = { ...process.env, LC_ALL: "en_US.UTF-8", LC_CTYPE: "UTF-8" };

export type PasteMode = "typing" | "clipboard";

/**
 * True when every character survives AppleScript's `keystroke` intact.
 *
 * Printable ASCII only, and deliberately conservative, because every failure here is silent
 * corruption rather than an error. Measured behaviour of the excluded characters:
 *
 *  - non-ASCII is replaced by "a" (`→ café 🎉 日本語` arrives as `a cafa aa aaa`)
 *  - newlines vanish entirely, so multi-line text is silently joined into one line
 *  - tabs are delivered as real Tab presses, which move focus — so the remainder of the text
 *    is typed into whatever gained focus, not the intended field
 *
 * The last two matter even though tabs and newlines are ASCII, which is why this checks the
 * printable range rather than the full 7-bit one.
 */
export function isKeystrokeSafe(text: string): boolean {
    return /^[\x20-\x7E]*$/.test(text);
}

/** Resolves the native helper, repairing the exec bit that `streamdeck pack` discards. */
async function findNativeHelper(): Promise<string | null> {
    try {
        await access(NATIVE_HELPER, constants.X_OK);
        return NATIVE_HELPER;
    } catch {
        try {
            await access(NATIVE_HELPER, constants.F_OK);
            await chmod(NATIVE_HELPER, 0o755);
            await access(NATIVE_HELPER, constants.X_OK);
            return NATIVE_HELPER;
        } catch {
            return null;
        }
    }
}

function spawnWithInput(
    command: string,
    args: string[],
    input: string,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], env });
        proc.on("error", reject);
        proc.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
        proc.stdin.write(input);
        proc.stdin.end();
    });
}

export async function readClipboard(): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("pbpaste", [], { env: CLIPBOARD_ENV, stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Uint8Array[] = [];
        proc.stdout.on("data", chunk => chunks.push(chunk));
        proc.on("error", reject);
        // Concatenated before decoding, so a multi-byte character split across two reads
        // cannot be mangled at the chunk boundary.
        proc.on("close", code => code === 0
            ? resolve(Buffer.concat(chunks).toString("utf8"))
            : reject(new Error(`pbpaste exited with code ${code}`)));
    });
}

export async function writeClipboard(text: string): Promise<void> {
    return spawnWithInput("pbcopy", [], text, CLIPBOARD_ENV);
}

async function pressCommandV(): Promise<void> {
    await execAsync('osascript -e \'tell application "System Events" to keystroke "v" using command down\'');
}

/** Types via AppleScript. Only safe for ASCII — see {@link isKeystrokeSafe}. */
async function typeViaAppleScript(text: string): Promise<void> {
    const script = `tell application "System Events" to keystroke "${escapeForAppleScript(text)}"`;
    return spawnWithInput("osascript", ["-"], script);
}

/**
 * Pastes exactly, then puts back what was on the clipboard before.
 *
 * Restoration is best-effort and text-only: a clipboard holding an image or rich content comes
 * back as whatever `pbpaste` could render, so this is a fallback rather than a default.
 */
async function typeViaBorrowedClipboard(text: string): Promise<void> {
    let previous: string | null = null;
    try {
        previous = await readClipboard();
    } catch {
        // Nothing readable to preserve; proceed rather than refusing to paste.
    }
    await writeClipboard(text);
    await pressCommandV();
    if (previous !== null) {
        await new Promise(r => setTimeout(r, PASTE_SETTLE_MS));
        await writeClipboard(previous).catch(() => { /* leave the pasted text rather than fail */ });
    }
}

/**
 * Emits `text` into the frontmost application.
 *
 * @param onWarn Reports which fallback was taken, so a corrupted or clipboard-borrowing paste
 * is explicable after the fact instead of a mystery.
 */
export async function outputText(
    text: string,
    mode: PasteMode,
    onWarn?: (message: string) => void
): Promise<void> {
    if (mode === "clipboard") {
        // The user opted into using the clipboard, so leave the text on it.
        await writeClipboard(text);
        await pressCommandV();
        return;
    }

    const helper = await findNativeHelper();
    if (helper) {
        try {
            await spawnWithInput(helper, ["--type-text"], text);
            return;
        } catch (error) {
            onWarn?.(`native typing helper failed, falling back: ${String(error)}`);
        }
    }

    if (isKeystrokeSafe(text)) {
        await typeViaAppleScript(text);
        return;
    }

    onWarn?.("text contains characters AppleScript cannot type (non-ASCII, newlines or tabs) " +
             "and no native helper is available; pasting via the clipboard and restoring it");
    await typeViaBorrowedClipboard(text);
}
