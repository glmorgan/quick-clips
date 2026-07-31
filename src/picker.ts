import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { normalize } from "node:path";
import { AddressInfo } from "node:net";

/**
 * A rich, in-browser replacement for the osascript `choose from list` picker.
 *
 * Serves a single-page picker on an ephemeral 127.0.0.1 port and displays it in a
 * chromeless Chromium "app mode" window. Unlike `choose from list`, this can show the
 * action's own icons, real section headers, type-to-filter, and keyboard navigation.
 *
 * The caller gets back an item **id** rather than a display string, which removes the
 * label-to-id reverse mapping the AppleScript picker forced on us.
 *
 * Callers must handle a `null` result (cancelled or timed out) and should fall back to
 * the osascript picker when {@link findHosts} returns an empty list.
 */

export type PickerItem = {
    /** Stable identifier returned to the caller — never a display string. */
    id: string;
    label: string;
    group: string;
    /**
     * Path to a PNG relative to the sdPlugin root, e.g. `imgs/actions/utils/upper`.
     * Optional: stored clips have no per-item art.
     */
    icon?: string;
    /** Secondary line under the label — the clip's text, or a generated sample. */
    preview?: string;
    /**
     * The user-set name, when there is one. Distinct from `label`, which may be a derived
     * summary — the editor must open with what the user typed, not with generated text.
     */
    title?: string;
    /** Whether this row is currently masked, so the control can show the right state. */
    hidden?: boolean;
    /**
     * Exactly what the filter should match, when the visible text is not the whole story — a
     * named row displays its name but should still be findable by its value, and a masked row
     * must *not* be findable by the value it is hiding. Falls back to the label.
     */
    search?: string;
    /** Hex accent used for the selected-card outline; should match the icon's own accent bar. */
    accent?: string;
    /**
     * Short computed tag shown at the start of the row, e.g. "JSON" or "URL". Rendered in a
     * fixed-width slot so the badges line up into a scannable column.
     */
    badge?: {
        text: string;
        accent?: string;
        /**
         * Renders the badge slot as a filled colour chip instead of a label. Only a literal hex
         * colour is honoured — see the sanitising in renderHtml.
         */
        swatch?: string;
        /**
         * Extra words the filter should match, so a row can be found by its *kind* and not only
         * its contents — typing "json" finds JSON clips, not clips mentioning the word. Needed
         * especially for a swatch, which displays no text at all to match against.
         */
        search?: string;
    };
};

export type PickerOptions = {
    /** Heading shown at the top of the window. */
    title?: string;
    /** One-line explanation beneath the heading. */
    subtitle?: string;
    /**
     * Id of the item to open with selected, so reconfiguring starts from the current
     * setting rather than the top of the list. Unknown ids fall back to the first item.
     */
    selectedId?: string;
    /**
     * Rows that perform an operation instead of selecting, e.g. "Add from clipboard".
     * Choosing one leaves the window open so the result is visible.
     */
    actions?: { id: string; label: string; hint?: string }[];
    /**
     * Handles an action row. Returns the updated item list, which the picker re-renders.
     * Keeping this a callback leaves clipboard and settings logic in the action, not here.
     */
    onAction?: (actionId: string) => Promise<PickerItem[]>;
    /**
     * Deletes an item. Supplying this puts a delete control on every row and binds the Delete
     * key; omit it and the picker stays read-only. Returns the updated list to re-render.
     */
    onDelete?: (itemId: string) => Promise<PickerItem[]>;
    /**
     * Restores whatever `onDelete` last removed. Supplying this turns the post-delete notice into
     * an Undo affordance and binds ⌘Z to it; omit it and a delete is final.
     *
     * Returns the updated list to re-render, or throws with a reason the restore could not
     * happen, which the picker shows in place of the notice.
     */
    onUndoDelete?: () => Promise<PickerItem[]>;
    /**
     * Renames an item. Supplying this puts an edit control on every row and enables inline
     * editing of the label. An empty string means "clear the name".
     *
     * Editing happens inline rather than via `prompt()`, which silently does nothing in the
     * native host unless the web view implements a text-input panel.
     */
    onRename?: (itemId: string, title: string) => Promise<PickerItem[]>;
    /**
     * Toggles whether an item's value is masked on screen. Supplying this puts a hide control on
     * every row. Masking is the caller's job — the picker only renders what it is given and
     * reports the toggle.
     */
    onToggleHidden?: (itemId: string) => Promise<PickerItem[]>;
    /**
     * Whether the caller will type or paste immediately after a selection. When true the
     * picker waits for the window to close *and* for focus to land back on a real app before
     * resolving; otherwise keystrokes race the closing window. Off by default because the
     * transform picker only writes settings.
     */
    awaitFocusHandoff?: boolean;
    /**
     * `grid` packs short labelled items into columns — right for transforms, which are terse
     * and carry icons. `list` gives each row the full width, which long stored text needs to
     * stay readable rather than truncating a few characters in.
     */
    layout?: "grid" | "list";
    /** Placeholder for the filter field; defaults to a generic prompt. */
    filterPlaceholder?: string;
    /**
     * Content-area size. Per-caller because the two pickers want different shapes: the transform
     * grid needs width to hold four columns without scrolling, while a list of clips mostly has
     * short rows and reads better narrower.
     */
    width?: number;
    height?: number;
    /** Abandon the picker and resolve `null` after this many ms *without interaction*. */
    timeoutMs?: number;
    /**
     * Diagnostic channel: unservable assets, and anything the window host writes to stderr
     * (the native host reports its resolved geometry and any page-load failure there).
     *
     * Without it these failures are invisible — an unreadable icon just renders as blank space —
     * which is the hardest class of problem to diagnose from the outside. Kept as a callback so
     * this module stays free of any Stream Deck SDK coupling.
     */
    onWarn?: (message: string) => void;
    /**
     * Colour scheme. Defaults to `dark`, deliberately: the action icons are white glyphs on
     * transparency, so `light`/`auto` must darken them with a CSS filter to keep them legible,
     * which also flattens their coloured accent bars to grey. Dark is the only mode that shows
     * the icons exactly as they appear on the Stream Deck key, and it matches the app besides.
     */
    theme?: "auto" | "dark" | "light";
};

/** Chromium-family browsers that support `--app=` windows, in preference order. */
const BROWSER_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
];

/**
 * How long the picker may sit *idle* before giving up and closing.
 *
 * Re-armed on every interaction, so it bounds abandonment rather than the whole session — an
 * absolute limit would close the window mid-task on anyone working through a list.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * How long a host gets to fetch the page before it is judged to have failed.
 *
 * A host that macOS refuses to run does not always exit — a blocked binary can hang instead,
 * which is indistinguishable from a launched host until you notice it never asked for the page.
 * Without this, such a host consumed the full idle timeout and then reported a cancellation, so
 * the picker silently did nothing rather than falling back to a browser that was right there.
 */
const PAGE_LOAD_TIMEOUT_MS = 6_000;
/**
 * Target size of the *content area*. The head script adds the browser's own chrome (title bar
 * and borders) on top of these, so the usable area is these dimensions on any browser.
 */
const WINDOW_WIDTH = 860;
const WINDOW_HEIGHT = 670;
/**
 * Fraction of the leftover vertical space placed *above* the window. 0.5 is dead centre;
 * lower values sit it higher, which reads better for a transient picker — the optical-centre
 * convention Spotlight and Raycast use. Scales with the window height, so it stays balanced
 * if WINDOW_HEIGHT changes.
 */
const VERTICAL_BIAS = 0.35;
/** Icon densities to try, in order. @2x first so retina art wins when both exist. */
const ICON_SUFFIXES = ["@2x.png", ".png"] as const;

/**
 * Bundled native window host, relative to the sdPlugin root. Built by `npm run build:native`
 * and absent from a plain `npm run build`, hence the browser fallback.
 */
const NATIVE_HOST = "bin/picker-host";

/**
 * Thrown when a host could not be launched at all, as distinct from the user cancelling.
 * Callers should try the next host rather than treating it as "no selection".
 */
export class PickerHostLaunchError extends Error {}

/**
 * Returns every command capable of displaying the picker, best first.
 *
 * The native host comes first: it needs no browser installed, creates the window already sized
 * and positioned (so there is no visible resize), and does not borrow the user's browser
 * profile. Chromium-family browsers follow.
 *
 * Returns them all rather than just the best, because a host can be present yet unlaunchable —
 * an unsigned native host on a machine where Gatekeeper quarantined it is the common case. The
 * caller works down the list, then falls back to osascript if every one fails.
 */
export async function findHosts(): Promise<string[]> {
    const { access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    const hosts: string[] = [];
    try {
        // Must be executable, not merely present — an unbuilt or non-executable file is useless.
        await access(NATIVE_HOST, constants.X_OK);
        hosts.push(NATIVE_HOST);
    } catch {
        // `streamdeck pack` stores no permission bits at all, so a host installed from a packaged
        // plugin arrives without its exec bit and cannot be spawned. plugin.js is unaffected
        // because Stream Deck runs it as an argument to node. Restore the bit rather than
        // silently falling back to a browser for every packaged install.
        try {
            await access(NATIVE_HOST, constants.F_OK);
            const { chmod } = await import("node:fs/promises");
            await chmod(NATIVE_HOST, 0o755);
            await access(NATIVE_HOST, constants.X_OK);
            hosts.push(NATIVE_HOST);
        } catch {
            // not built for this checkout, or the location is not writable — browsers only
        }
    }
    for (const path of BROWSER_CANDIDATES) {
        try {
            await access(path);
            hosts.push(path);
        } catch {
            // not installed — try the next candidate
        }
    }
    return hosts;
}

/**
 * Waits until a real application is frontmost again after the picker window closes.
 *
 * Measured on a real click: the host exits ~19ms after the selection, but focus passes through
 * a brief state where no app is frontmost and only lands on the previous app at ~32ms. Typing
 * inside that gap goes nowhere, or worse into the closing window — so callers that paste must
 * wait for the handoff rather than for the selection alone. Polls observed state instead of
 * sleeping a guessed constant, so it still holds on a slower machine.
 */
async function waitForFocusHandoff(timeoutMs = 500): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const { stdout } = await run("lsappinfo", ["front"]);
            const asn = stdout.trim();
            if (asn) {
                const { stdout: name } = await run("lsappinfo", ["info", "-only", "name", asn]);
                // "[ NULL ]" is the transient no-frontmost-app state while the window closes.
                if (name.includes("=") && !name.includes("NULL") && !name.includes("picker-host")) {
                    return;
                }
            }
        } catch {
            // lsappinfo unavailable — do not block the paste on a diagnostic tool
            return;
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

/** Escapes text for safe interpolation into an HTML text node or attribute. */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Serialises data for embedding in a `<script>` block.
 * `<` must be escaped or a `</script>` inside the data would terminate the block early.
 */
function embedJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

const DEFAULT_ACCENT = "#6d9eeb";

/**
 * Eye / eye-with-slash for the hide toggle.
 *
 * Inline SVG rather than a Unicode glyph: the eye emoji renders in colour and ignores the
 * surrounding text colour, and Unicode has no dependable struck-through eye at all. `currentColor`
 * lets the existing contrast rules drive these the same as the other controls.
 */
const EYE_SVG =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M2 12c3-5.5 6.7-8 10-8s7 2.5 10 8c-3 5.5-6.7 8-10 8s-7-2.5-10-8Z"/>`
    + `<circle cx="12" cy="12" r="3.2"/></svg>`;

const PENCIL_SVG =
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M4 20.5l4.2-1L20 7.7a2.1 2.1 0 0 0-3-3L5 16.4 4 20.5Z"/>`
    + `<path d="M14.8 6.9l2.9 2.9"/></svg>`;

// Heavier stroke than the other two: a cross is two thin diagonals, which lay down less ink
// than the eye's curves or the pencil's body and so read lighter at the same colour.
const CROSS_SVG =
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"`
    + ` stroke-width="2.4" stroke-linecap="round" aria-hidden="true">`
    + `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;

const EYE_OFF_SVG =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M2 12c3-5.5 6.7-8 10-8s7 2.5 10 8c-3 5.5-6.7 8-10 8s-7-2.5-10-8Z"/>`
    + `<circle cx="12" cy="12" r="3.2"/>`
    + `<path d="M3.5 3.5l17 17"/></svg>`;

/** Hex colours only. The value originates from the user's clipboard and lands in a style
 * attribute, so it is re-validated here rather than trusted from the caller. */
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function renderBadge(badge: PickerItem["badge"]): string {
    if (!badge) return "";
    // A swatch shows the colour itself, which a text label cannot. Deliberately a *filled* chip
    // with a neutral ring rather than tinted text: a near-black or near-white value would be
    // invisible if the colour were used for the border or glyph.
    if (badge.swatch && HEX_COLOUR.test(badge.swatch)) {
        return `<span class="badge swatch" title="${escapeHtml(badge.swatch)}"`
            + ` style="--swatch:${escapeHtml(badge.swatch)}"></span>`;
    }
    return `<span class="badge" style="--badge:${escapeHtml(badge.accent ?? "#8b8b93")}">`
        + `${escapeHtml(badge.text)}</span>`;
}

function renderHtml(
    items: PickerItem[],
    token: string,
    options: Required<Pick<PickerOptions, "title">> & PickerOptions,
    theme: "auto" | "dark" | "light"
): string {
    const winW = options.width ?? WINDOW_WIDTH;
    const winH = options.height ?? WINDOW_HEIGHT;
    const { title, subtitle, selectedId, actions } = options;
    const layout = options.layout ?? "grid";

    const groups = [...new Set(items.map(i => i.group))];
    const sections = groups.map(group => {
        const cards = items
            .filter(i => i.group === group)
            .map(item => `
        <div class="card${item.id === selectedId ? " is-current" : ""}" role="option" tabindex="-1"
                data-id="${escapeHtml(item.id)}"
                data-label="${escapeHtml(item.label)}"
                data-title="${escapeHtml(item.title ?? "")}"
                data-search="${escapeHtml(
                    [item.search ?? item.label, item.group,
                     item.badge?.search ?? item.badge?.text ?? ""]
                        .join(" ").toLowerCase()
                )}"
                ${item.id === selectedId ? 'title="Currently set on this button"' : ""}
                style="--accent:${escapeHtml(item.accent ?? DEFAULT_ACCENT)}">
          ${item.icon ? `<img class="icon" src="/icon?t=${token}&p=${encodeURIComponent(item.icon)}" alt="" />` : ""}
          ${renderBadge(item.badge)}
          <span class="text${item.preview ? " has-detail" : ""}">
            <span class="label">${escapeHtml(item.label)}</span>
            ${item.preview ? `<span class="preview">${escapeHtml(item.preview)}</span>` : ""}
          </span>
          ${(options.onToggleHidden || options.onRename || options.onDelete)
            ? `<span class="controls">` : ""}
          ${options.onToggleHidden ? `<span class="hide${item.hidden ? " on" : ""}" role="button"`
            + ` title="${item.hidden ? "Show value" : "Hide value from view (not encrypted)"}">`
            + (item.hidden ? EYE_OFF_SVG : EYE_SVG) + `</span>` : ""}
          ${options.onRename ? `<span class="edit" role="button" title="Rename (or press F2)">` + PENCIL_SVG + `</span>` : ""}
          ${options.onDelete ? `<span class="del" role="button" title="Delete this clip">` + CROSS_SVG + `</span>` : ""}
          ${(options.onToggleHidden || options.onRename || options.onDelete) ? `</span>` : ""}
        </div>`)
            .join("");
        return `<section><h2>${escapeHtml(group)}</h2><div class="grid">${cards}</div></section>`;
    }).join("");

    // Action rows come first so an empty collection still offers something to do.
    const actionSection = (actions ?? []).length === 0 ? "" : `
    <section><div class="grid">${(actions ?? []).map(a => `
      <div class="card is-action" role="option" tabindex="-1" data-action="${escapeHtml(a.id)}"
           data-label="${escapeHtml(a.label)}" data-search="">
        <span class="plus">+</span>
        <span class="text">
          <span class="label">${escapeHtml(a.label)}</span>
          ${a.hint ? `<span class="preview">${escapeHtml(a.hint)}</span>` : ""}
        </span>
      </div>`).join("")}</div></section>`;

    // Light tokens are declared twice: once behind the media query (the `auto` default) and
    // once behind [data-theme="light"], so an explicit override beats the OS in both directions.
    const lightTokens = `
      --bg: #f6f6f8;
      --header: rgba(246,246,248,.92);
      --line: rgba(0,0,0,.09);
      --fg: #16161a;
      --fg-dim: #62626c;
      --fg-faint: #94949e;
      --card: #ffffff;
      --card-line: rgba(0,0,0,.08);
      --hover: rgba(0,0,0,.03);
      --kbd: rgba(0,0,0,.06);
      --mark: #a86a00;
      --shadow: 0 1px 2px rgba(0,0,0,.05);
      --shadow-lift: 0 4px 14px rgba(0,0,0,.10);
      --glyph: brightness(.24) saturate(0);`;

    return `<!doctype html>
<html lang="en" data-layout="${layout}"${theme === "auto" ? "" : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<script>
/*
 * Runs before the body is parsed, so the window is resized and centred ahead of first paint.
 *
 * Chrome ignores --window-size/--window-position whenever it is already running, and ad-hoc
 * --app launches do not persist window geometry between runs, so the window always opens at
 * some arbitrary default (observed anywhere from 1200 to 1735 wide). Laying the grid out at
 * that width first would flash ~8 columns before reflowing to 4, so the body stays hidden
 * until the resize lands. The page background is on <html>, which stays visible, so the gap
 * reads as an empty themed window rather than a white flash.
 */
(function () {
  var W = ${winW}, H = ${winH};
  var root = document.documentElement;
  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    root.classList.add('ready');
  }
  // The native host creates the window at the right size and place before the page loads, so
  // there is nothing to correct. Calling resizeTo() there would actively hurt: it sizes the
  // outer frame and would cost 32px of content height.
  if (window.__nativeHost) {
    reveal();
    return;
  }
  try {
    // resizeTo sizes the *outer* window, which includes the title bar, so asking for H
    // directly leaves the content short by the height of that chrome and clips the last row.
    // The delta is size-independent, so it can be measured before resizing.
    var chromeW = Math.max(0, window.outerWidth - window.innerWidth);
    var chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    var outerW = W + chromeW, outerH = H + chromeH;
    window.resizeTo(outerW, outerH);
    // availLeft/availTop are the origin of the display this window landed on, so this centres
    // on that monitor rather than assuming the primary one, and clears the menu bar.
    // Horizontally centred; vertically biased above centre — see VERTICAL_BIAS.
    window.moveTo(
      Math.round((screen.availWidth - outerW) / 2) + (screen.availLeft || 0),
      Math.round((screen.availHeight - outerH) * ${VERTICAL_BIAS}) + (screen.availTop || 0)
    );
  } catch (e) {
    // A browser may refuse to move a window it did not script-open — show content regardless.
    reveal();
  }
  // resizeTo is a request, not a synchronous change, so wait for it to actually land.
  window.addEventListener('resize', function onResize() {
    window.removeEventListener('resize', onResize);
    requestAnimationFrame(reveal);
  });
  // Fallback for the case where no resize is needed and no event ever fires.
  setTimeout(reveal, 250);
})();
</script>
<style>
  :root {
    --bg: #333333;
    /* Translucent form of --bg so the sticky header reads as the same surface */
    --header: rgba(51,51,51,.92);
    --line: rgba(255,255,255,.08);
    --fg: #f4f4f6;
    --fg-dim: #8b8b93;
    --fg-faint: #62626b;
    --card: #262626;
    --card-line: #515151;
    --hover: rgba(255,255,255,.04);
    --kbd: rgba(255,255,255,.09);
    --mark: #ffd979;
    --shadow: 0 1px 2px rgba(0,0,0,.3);
    --shadow-lift: 0 6px 18px rgba(0,0,0,.45);
    --glyph: none;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme]) {${lightTokens}
    }
  }
  :root[data-theme="light"] {${lightTokens}
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* Background lives on <html> so the window is themed even while <body> is hidden. */
  html { background: var(--bg); }
  /* Content stays hidden until the window has been resized — see the head script. */
  html:not(.ready) body { visibility: hidden; }
  body {
    margin: 0;
    font: 400 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
    background: var(--bg); color: var(--fg);
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none; user-select: none;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 22px; }

  header {
    flex: 0 0 auto;
    background: var(--header);
    backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid var(--line);
    padding: 12px 0 0;
  }
  .titles { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.015em; }
  .sub { font-size: 12px; color: var(--fg-dim); }

  .searchbar {
    display: flex; align-items: center; gap: 9px;
    margin: 7px 0 0; padding: 0 0 9px;
  }
  .searchbar svg { flex: 0 0 15px; color: var(--fg-faint); }
  #q {
    flex: 1 1 auto; min-width: 0; border: 0; background: transparent; color: var(--fg);
    font: 400 14px/1.3 inherit; letter-spacing: -.01em; outline: none; padding: 0;
  }
  #q::placeholder { color: var(--fg-faint); }
  #count { flex: 0 0 auto; font-size: 11px; color: var(--fg-faint); font-variant-numeric: tabular-nums; }

  main { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 2px 0 12px; }
  main::-webkit-scrollbar { width: 10px; }
  main::-webkit-scrollbar-thumb {
    background: var(--kbd); border-radius: 99px;
    border: 3px solid transparent; background-clip: content-box;
  }

  section { margin-top: 11px; }
  section.hidden { display: none; }
  h2 {
    margin: 0 0 5px; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--fg-faint);
  }

  .grid {
    display: grid; gap: 9px;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }
  /* One row per item, full width — long stored text is unreadable in narrow columns. */
  html[data-layout="list"] .grid { grid-template-columns: 1fr; gap: 5px; }

  .card {
    position: relative; display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; min-width: 0;
    border: 2px solid var(--card-line); border-radius: 11px;
    background: var(--card); color: inherit; text-align: left;
    font: inherit; cursor: pointer; box-shadow: var(--shadow);
    /* Rows were <button> elements until an <input> had to live inside one: nesting interactive
       controls in a button is invalid, and the browser routes Space and Enter to the button,
       so typing a label with a space in it selected the row and pasted it. */
    outline: none; user-select: none;
    transition: border-color 110ms ease, box-shadow 110ms ease, transform 110ms ease, background 110ms ease;
  }
  .card.hidden { display: none; }
  .card:hover { background: var(--hover); }
  /*
   * Marks the transform the button is already set to. Stays in the item's accent colour
   * regardless of cursor position — the selection ring moves as you navigate, so this is the
   * only persistent way to find the current setting after arrowing around.
   */
  .card.is-current::after {
    content: ""; position: absolute; top: 9px; right: 10px;
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--accent);
  }

  /* Only the border colour changes — no inset ring, so the border stays 2px throughout. */
  .card.active {
    border-color: var(--accent);
    box-shadow: var(--shadow-lift);
    transform: translateY(-1px);
  }
  .card:active { transform: translateY(0); }

  /* Icons are shown exactly as they appear on the Stream Deck key — no tint, no container. */
  .icon { flex: 0 0 30px; width: 30px; height: 30px; object-fit: contain; display: block; filter: var(--glyph); }

  /*
   * Label and preview sit on one line rather than stacking, so a row is the same height whether
   * or not it has been given a name. Stacking made named rows taller and left the list with a
   * ragged rhythm; padding the short rows to match would have wasted the space on every
   * unnamed row instead.
   */
  .text { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1 1 auto; }
  .preview {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 10.5px; color: var(--fg-dim); letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Action rows read as "do something" rather than "pick something". */
  .card.is-action { border-style: dashed; }
  .card.is-action .label { color: var(--fg-dim); }
  .card.is-action:hover, .card.is-action.active { border-style: solid; }
  .card.is-action:hover .label, .card.is-action.active .label { color: var(--fg); }
  .plus {
    flex: 0 0 30px; width: 30px; height: 30px; display: grid; place-items: center;
    border-radius: 8px; background: var(--kbd); color: var(--fg-dim); font-size: 17px;
  }
  /*
   * Deleting is click-only, deliberately. Every keyboard binding collided with editing the
   * filter, which is focused by default: a bare Backspace fired the moment a search term was
   * cleared, and Cmd+Backspace is macOS's own "delete to beginning of line". A small, specific
   * target is inherently deliberate in a way a keystroke is not.
   *
   * Always visible rather than revealed on hover: a control you cannot see is a control you do
   * not know exists, and a hover-only target on a full-width row is easy to miss entirely.
   * Sized generously for the same reason — the glyph is small but the hit area is not.
   */
  /*
   * Fixed width so badges form an aligned column — the point is scanning a long list, which a
   * ragged left edge defeats. Border plus a faint infill of the same hue reads as a tag without
   * competing with the clip text for attention.
   */
  .badge {
    flex: 0 0 52px; width: 52px; text-align: center;
    padding: 3px 0; border-radius: 5px;
    font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--badge);
    border: 1px solid color-mix(in srgb, var(--badge) 45%, transparent);
    background: color-mix(in srgb, var(--badge) 12%, transparent);
  }

  .badge.swatch {
    background: var(--swatch);
    border: 1px solid rgba(255,255,255,.28);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.35);
    padding: 0; height: 20px;
  }

  /*
   * Contrast, not opacity. A faint glyph at 45% measured 1.49:1 against the card, well under
   * the 3:1 WCAG asks of non-text controls — and hover only reached 2.18:1. Setting the colour
   * directly gives 4.48:1 at rest and full contrast on hover, with no compounding.
   */
  /*
   * The row's 10px gap applies between every child, which spaced the controls as far apart from
   * each other as from the text. Clustering them keeps the row readable as "content, then
   * actions" and buys back horizontal space.
   */
  .controls { flex: 0 0 auto; display: flex; align-items: center; gap: 1px; margin-left: 2px; }

  .hide, .edit, .del {
    flex: 0 0 auto; width: 26px; height: 26px; display: grid; place-items: center;
    border-radius: 6px; color: var(--fg-dim); line-height: 1;
    transition: background 110ms ease, color 110ms ease;
  }
  .hide svg, .edit svg, .del svg { display: block; }
  .card:hover .hide, .card.active .hide { color: var(--fg); }
  .hide:hover { background: var(--kbd); color: var(--fg); }
  /* A masked row keeps its control lit, so the state is legible without hovering. */
  .hide.on { color: var(--accent); }

  .card:hover .edit, .card.active .edit { color: var(--fg); }
  .edit:hover { background: var(--kbd); color: var(--fg); }

  .card:hover .del, .card.active .del { color: var(--fg); }
  .del:hover { background: var(--kbd); color: #ff6b6b; }
  /* The inline editor replaces the label in place, so the row does not jump while renaming. */
  .rename {
    flex: 1 1 auto; min-width: 0; font: inherit; font-size: 13px; font-weight: 550;
    color: var(--fg); background: var(--bg); border: 1px solid var(--accent);
    border-radius: 6px; padding: 3px 7px; outline: none;
  }

  .label {
    flex: 0 1 auto; min-width: 0;
    font-size: 13px; font-weight: 550;
    letter-spacing: -.008em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /*
   * Only capped when a value shares the line, so a long name cannot push it off the row.
   * Applying this unconditionally truncated every label that had nothing beside it — which is
   * every card in the transform grid, and every unnamed clip.
   */
  .text.has-detail .label { max-width: 55%; }
  .label mark { background: transparent; color: var(--mark); font-weight: 700; }

  footer {
    flex: 0 0 auto; border-top: 1px solid var(--line); background: var(--header);
  }
  footer .wrap { display: flex; align-items: center; gap: 16px; height: 38px; }
  footer span { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-faint); }
  kbd {
    display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px;
    background: var(--kbd); border-radius: 4px; font: inherit; font-size: 10px; color: var(--fg-dim);
  }

  #notice {
    position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%) translateY(8px);
    display: flex; align-items: center; gap: 12px;
    background: var(--card); border: 2px solid var(--card-line); border-radius: 9px;
    padding: 8px 10px 8px 14px; font-size: 12px; color: var(--fg);
    opacity: 0; pointer-events: none; transition: opacity 140ms ease, transform 140ms ease;
  }
  /* Clickable only while shown, or the invisible toast would swallow clicks on the rows under it. */
  #notice.show { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
  /* Bounded so a long clip name cannot stretch the toast past the window. */
  #notice-text { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #notice-undo {
    display: none; align-items: center; gap: 6px; padding: 3px 8px;
    background: var(--kbd); border: 1px solid var(--card-line); border-radius: 6px;
    font: inherit; font-size: 12px; color: var(--fg); cursor: pointer;
  }
  #notice.undoable #notice-undo { display: inline-flex; }
  #notice-undo:hover { background: var(--card-line); }
  #notice-undo kbd { background: transparent; color: var(--fg-faint); min-width: 0; padding: 0; }

  #empty { display: none; padding: 52px 16px; text-align: center; }
  #empty.show { display: block; }
  #empty .big { font-size: 13px; color: var(--fg-dim); }
  #empty .small { font-size: 11px; color: var(--fg-faint); margin-top: 4px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="titles">
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<span class="sub">${escapeHtml(subtitle)}</span>` : ""}
    </div>
    <div class="searchbar">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <input id="q" type="text" placeholder="${escapeHtml(options.filterPlaceholder ?? "Filter…")}" autocomplete="off"
             spellcheck="false" autofocus role="combobox" aria-expanded="true" />
      <span id="count"></span>
    </div>
  </div>
</header>
<main role="listbox">
  <div class="wrap">
    ${actionSection}
    ${sections}
    <div id="empty">
      <div class="big">No matching transform</div>
      <div class="small">Try a different search</div>
    </div>
  </div>
</main>
<div id="notice">
  <span id="notice-text"></span>
  <button id="notice-undo" type="button">Undo <kbd>⌘Z</kbd></button>
</div>
<footer>
  <div class="wrap">
    <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> navigate</span>
    <span><kbd>↵</kbd> select</span>
    ${options.onRename ? "<span><kbd>F2</kbd> rename</span>" : ""}

    <span><kbd>esc</kbd> cancel</span>
  </div>
</footer>
<script>
(function () {
  var TOKEN = ${embedJson(token)};
  var SELECTED = ${embedJson(selectedId ?? null)};
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('section'));
  var q = document.getElementById('q');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var active = 0;
  var sent = false;
  /** Whether the toast is currently offering to undo a delete, which is what arms ⌘Z. */
  var undoPending = false;
  /** Identifies the newest notice, so an older one's timer cannot dismiss it early. */
  var noticeSeq = 0;

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function visible() {
    return cards.filter(function (c) { return !c.classList.contains('hidden'); });
  }

  /**
   * Index of the first row that can actually be chosen.
   *
   * Action rows are never hidden by the filter, so they sit at index 0 and would otherwise be
   * the default target — pressing Enter after narrowing to one clip would "Add from clipboard"
   * instead of pasting the match. Falls back to 0 when nothing selectable remains, which is the
   * empty-collection case where the action row is the only sensible target.
   */
  function firstSelectable() {
    var vis = visible();
    for (var i = 0; i < vis.length; i++) {
      if (!vis[i].dataset.action) return i;
    }
    return 0;
  }

  /** Re-renders the label with the matched substring wrapped in <mark>. */
  function highlight(card, term) {
    var label = card.dataset.label;
    var el = card.querySelector('.label');
    if (!label || !el) return;
    if (!term) { el.textContent = label; return; }
    var at = label.toLowerCase().indexOf(term);
    if (at === -1) { el.textContent = label; return; }
    el.innerHTML = esc(label.slice(0, at)) + '<mark>' +
      esc(label.slice(at, at + term.length)) + '</mark>' + esc(label.slice(at + term.length));
  }

  function paint() {
    var vis = visible();
    if (active >= vis.length) active = Math.max(0, vis.length - 1);
    cards.forEach(function (c) { c.classList.remove('active'); });
    if (vis[active]) {
      vis[active].classList.add('active');
      vis[active].scrollIntoView({ block: 'nearest' });
    }
    empty.classList.toggle('show', vis.length === 0);
    sections.forEach(function (s) {
      var any = Array.prototype.slice.call(s.querySelectorAll('.card'))
        .some(function (c) { return !c.classList.contains('hidden'); });
      s.classList.toggle('hidden', !any);
    });
    // Action rows are always visible, so counting them would make the total look wrong.
    var selectable = cards.filter(function (c) { return !c.dataset.action; });
    var visSelectable = vis.filter(function (c) { return !c.dataset.action; });
    count.textContent = visSelectable.length === selectable.length
      ? '' : visSelectable.length + ' of ' + selectable.length;
  }

  /**
   * Cards are laid out in a responsive grid that spans multiple sections, so row/column
   * position is only knowable from geometry. Vertical moves pick the card in the nearest
   * row above/below whose horizontal centre is closest to the current one.
   */
  function moveVertical(dir) {
    var vis = visible();
    var cur = vis[active];
    if (!cur) return;
    var box = cur.getBoundingClientRect();
    var cx = box.left + box.width / 2;
    var best = -1, bestScore = Infinity;
    vis.forEach(function (c, i) {
      if (i === active) return;
      var b = c.getBoundingClientRect();
      if (dir > 0 ? b.top <= box.top + 1 : b.top >= box.top - 1) return;
      var dy = Math.abs(b.top - box.top);
      var dx = Math.abs(b.left + b.width / 2 - cx);
      var score = dy * 1000 + dx;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best !== -1) { active = best; paint(); }
  }

  function send(id) {
    if (sent) return;
    sent = true;
    // keepalive lets the request survive the window closing underneath it
    fetch('/message?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'select', id: id }),
      keepalive: true
    }).catch(function () {}).then(function () { window.close(); });
  }

  /**
   * Action rows mutate the list rather than choosing from it, so the window stays open.
   * Reloading re-renders server-side, which avoids maintaining a second copy of the card
   * markup in JS; the page is local so the reload is imperceptible.
   */
  /**
   * Rebuilds the list after it changed, without navigating.
   *
   * Neither location.reload() nor location.replace() reliably re-renders inside the native web
   * view — the row stayed on screen after a delete even though it was already gone from
   * settings, and only reappeared corrected when the window was reopened. Fetching the fresh
   * markup and swapping <main> sidesteps navigation and caching altogether, and keeps the
   * filter text and scroll position intact as a bonus.
   */
  function refresh() {
    // Remember which row was highlighted; the swap below replaces every node, and resetting to
    // the top made the highlight jump away from the row you just acted on and then snap back as
    // soon as the pointer moved.
    var vis = visible();
    var keepId = vis[active] ? vis[active].dataset.id : null;
    var keepAction = vis[active] ? vis[active].dataset.action : null;

    fetch(location.pathname + '?t=' + encodeURIComponent(TOKEN) + '&_=' + Date.now(),
          { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (markup) {
        var doc = new DOMParser().parseFromString(markup, 'text/html');
        var fresh = doc.querySelector('main .wrap');
        var current = document.querySelector('main .wrap');
        if (!fresh || !current) return;
        current.innerHTML = fresh.innerHTML;
        // Re-query, because every node in <main> was just replaced.
        cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
        sections = Array.prototype.slice.call(document.querySelectorAll('section'));
        empty = document.getElementById('empty');
        bindCards();
        // Re-apply the active filter so a mutation does not silently widen the list.
        var term = q.value.trim().toLowerCase();
        cards.forEach(function (c) {
          if (c.dataset.action) return;
          var hay = c.dataset.search || '';
          c.classList.toggle('hidden', term !== '' && hay.indexOf(term) === -1);
          highlight(c, term);
        });
        // Restore the previously highlighted row when it still exists, else fall back.
        active = firstSelectable();
        if (keepId || keepAction) {
          var after = visible();
          for (var i = 0; i < after.length; i++) {
            if ((keepId && after[i].dataset.id === keepId)
                || (keepAction && after[i].dataset.action === keepAction)) {
              active = i;
              break;
            }
          }
        }
        paint();
      })
      .catch(function (e) { report('refresh failed: ' + e); });
  }

  function runAction(actionId) {
    if (sent) return;
    fetch('/message?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'action', action: actionId })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.message) { showNotice(res.message); }
      else { refresh(); }
    }).catch(function () {});
  }

  /** Removes an item, keeping the window open so the list can be worked through. */
  function runDelete(itemId) {
    if (sent) return;
    fetch('/message?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'delete', id: itemId })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.message) { showNotice(res.message); return; }
      // Removed in place rather than re-fetching: navigation does not re-render inside the
      // native web view, and a local node removal cannot fail for environment reasons.
      var card = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].dataset.id === itemId) { card = cards[i]; break; }
      }
      // Where the row sat, so the highlight can stay put instead of jumping to the top of the
      // list — which lands on a row the pointer never touched and reads as a phantom hover.
      var wasAt = card ? visible().indexOf(card) : -1;
      if (card && card.parentNode) { card.parentNode.removeChild(card); }
      cards = cards.filter(function (c) { return c !== card; });

      var after = visible();
      if (wasAt === -1 || after.length === 0) {
        active = firstSelectable();
      } else {
        // Whatever slid up into the vacated slot, clamped when the last row was removed.
        active = Math.min(wasAt, after.length - 1);
        // Never settle on the Add row while a real clip is still available.
        if (after[active] && after[active].dataset.action) active = firstSelectable();
      }
      paint();
      if (res && res.undo) {
        undoPending = true;
        showNotice(res.label ? 'Deleted “' + res.label + '”' : 'Clip deleted', true);
      }
    }).catch(function (e) { report('delete failed: ' + e); });
  }

  /** Sends a page-side failure to the plugin log; these are otherwise completely invisible. */
  function report(message) {
    try {
      fetch('/message?t=' + encodeURIComponent(TOKEN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'error', message: String(message) }), keepalive: true
      }).catch(function () {});
    } catch (e) { /* nothing more we can do from here */ }
  }

  window.addEventListener('error', function (e) {
    report('uncaught: ' + (e && e.message) + ' @' + (e && e.lineno));
  });
  window.addEventListener('unhandledrejection', function (e) {
    report('unhandled rejection: ' + (e && e.reason));
  });

  /** True while a row is being renamed, so global keys do not fight the editor. */
  function isEditing() {
    return !!document.querySelector('.rename');
  }

  /**
   * Swaps the row's label for an input, in place.
   *
   * prompt() would be simpler but does nothing in the native host unless the web view
   * implements a text-input panel, so the editor is ordinary DOM.
   */
  function beginRename(card) {
    if (isEditing()) return;
    var text = card.querySelector('.text');
    var labelEl = card.querySelector('.label');
    if (!text || !labelEl) return;

    var input = document.createElement('input');
    input.className = 'rename';
    input.type = 'text';
    input.value = card.dataset.title || '';
    input.placeholder = 'Name this clip';
    labelEl.style.display = 'none';
    text.insertBefore(input, labelEl);
    input.focus();
    input.select();

    var done = false;
    function finishEdit(commit) {
      if (done) return;
      done = true;
      var next = input.value;
      input.remove();
      labelEl.style.display = '';
      if (!commit) return;
      fetch('/message?t=' + encodeURIComponent(TOKEN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'rename', id: card.dataset.id, title: next })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.message) { showNotice(res.message); return; }
        refresh();
      }).catch(function (e) { report('rename failed: ' + e); });
    }

    input.addEventListener('keydown', function (e) {
      // Every key, not just the ones handled below — Space used to reach the row and activate
      // it while a label containing a space was being typed.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    input.addEventListener('keypress', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', function () { finishEdit(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function runToggleHidden(itemId) {
    if (sent) return;
    fetch('/message?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'hide', id: itemId })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.message) { showNotice(res.message); return; }
      refresh();
    }).catch(function (e) { report('hide toggle failed: ' + e); });
  }

  /**
   * Bottom-centre toast. When undoable it offers to take the last delete back and stays up
   * longer, since it has to be read and acted on rather than merely noticed.
   */
  function showNotice(text, undoable) {
    var el = document.getElementById('notice');
    document.getElementById('notice-text').textContent = text;
    el.classList.toggle('undoable', !!undoable);
    el.classList.add('show');
    noticeSeq++;
    var mine = noticeSeq;
    setTimeout(function () {
      // A newer notice has taken over the element; leave it alone.
      if (mine !== noticeSeq) return;
      el.classList.remove('show');
      // ⌘Z stops working when the offer disappears, so the shortcut never does something
      // the window is no longer telling you it will do.
      undoPending = false;
    }, undoable ? 8000 : 2600);
  }

  function runUndo() {
    if (sent || !undoPending) return;
    undoPending = false;
    fetch('/message?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'undo' })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.message) {
        // Re-armed along with the message, so a restore that failed for a fixable reason —
        // no room right now — can be retried once the reason is gone.
        undoPending = true;
        showNotice(res.message, true);
        return;
      }
      document.getElementById('notice').classList.remove('show');
      refresh();
    }).catch(function (e) { report('undo failed: ' + e); });
  }

  document.getElementById('notice-undo').addEventListener('click', runUndo);

  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase();
    cards.forEach(function (c) {
      // Action rows stay visible while filtering — "Add from clipboard" is most useful exactly
      // when a search found nothing. They also carry no searchable text of their own.
      if (c.dataset.action) return;
      var hay = c.dataset.search || '';
      c.classList.toggle('hidden', term !== '' && hay.indexOf(term) === -1);
      highlight(c, term);
    });
    active = firstSelectable();
    paint();
  });

  document.addEventListener('keydown', function (e) {
    // The inline editor owns the keyboard while it is open.
    if (isEditing()) return;
    // Only claimed while an undo is actually on offer. The filter field has focus almost all the
    // time, so taking ⌘Z unconditionally would cost it its native text undo for nothing.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && undoPending) {
      e.preventDefault();
      runUndo();
      return;
    }
    var vis = visible();
    if (e.key === 'ArrowRight') { e.preventDefault(); active = Math.min(active + 1, vis.length - 1); paint(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveVertical(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveVertical(-1); }
    else if (e.key === 'Home') { e.preventDefault(); active = 0; paint(); }
    else if (e.key === 'End') { e.preventDefault(); active = vis.length - 1; paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var card = vis[active];
      if (!card) return;
      if (card.dataset.action) { runAction(card.dataset.action); return; }
      send(card.dataset.id);
    }
    else if (e.key === 'F2') {
      var renameTarget = vis[active];
      if (renameTarget && !renameTarget.dataset.action && renameTarget.querySelector('.edit')) {
        e.preventDefault();
        beginRename(renameTarget);
      }
    }
    else if (e.key === 'Escape') { e.preventDefault(); send(null); }
  });

  function bindCards() {
    cards.forEach(function (card) {
      if (card.dataset.bound) return;
      card.dataset.bound = '1';
      var hide = card.querySelector('.hide');
      if (hide) {
        hide.addEventListener('click', function (e) {
          e.stopPropagation();
          runToggleHidden(card.dataset.id);
        });
      }
      var edit = card.querySelector('.edit');
      if (edit) {
        edit.addEventListener('click', function (e) {
          e.stopPropagation();   // must not select and paste the row
          beginRename(card);
        });
      }
      var del = card.querySelector('.del');
      if (del) {
        del.addEventListener('click', function (e) {
          // Must not fall through to the card's own click, which would select and paste it.
          e.stopPropagation();
          runDelete(card.dataset.id);
        });
      }
      card.addEventListener('click', function () {
        if (card.dataset.action) { runAction(card.dataset.action); return; }
        send(card.dataset.id);
      });
      card.addEventListener('mousemove', function () {
        var at = visible().indexOf(card);
        if (at !== -1 && at !== active) { active = at; paint(); }
      });
    });
  }
  bindCards();

  window.addEventListener('beforeunload', function () { if (!sent) send(null); });

  // Open on the button's current setting so reconfiguring starts from where it is now,
  // otherwise on the first selectable row rather than an action button.
  active = firstSelectable();
  if (SELECTED) {
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].dataset.id === SELECTED) { active = i; break; }
    }
  }
  paint();
})();
</script>
</body>
</html>`;
}

/**
 * Displays the picker and resolves with the chosen item id, or `null` if the user
 * cancelled, closed the window, or the timeout elapsed.
 *
 * @param browserPath Executable from {@link findHosts}. Spawned directly rather than
 * via `open`, because `open -a` drops `--args` when the browser is already running,
 * which would surface the picker as an ordinary tab instead of an app window.
 */
export async function showPicker(
    items: PickerItem[],
    browserPath: string,
    options: PickerOptions = {}
): Promise<string | null> {
    const token = randomBytes(16).toString("hex");
    const title = options.title ?? "Choose transform";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let currentItems = items;
    let html = renderHtml(currentItems, token, { ...options, title }, options.theme ?? "dark");
    // Recomputed on every action, since a new item may reference an icon the old set lacked.
    let allowedIcons = new Set(currentItems.map(i => i.icon).filter((p): p is string => !!p));
    const warn = options.onWarn ?? (() => { /* caller opted out of diagnostics */ });

    return new Promise<string | null>((resolve, reject) => {
        let settled = false;
        let child: ChildProcess | undefined;
        let timer: NodeJS.Timeout | undefined;
        let loadWatchdog: NodeJS.Timeout | undefined;
        let pageServed = false;

        const server = createServer(handle);

        function finish(result: string | null): void {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (loadWatchdog) clearTimeout(loadWatchdog);
            server.close();
            // The app window owns no other tabs, so terminating it is safe.
            child?.kill();

            // Only a real selection is followed by typing, so only that needs the handoff wait.
            if (result === null || !options.awaitFocusHandoff) {
                resolve(result);
                return;
            }
            waitForFocusHandoff().then(() => resolve(result), () => resolve(result));
        }

        /** (Re)starts the idle countdown; every interaction pushes the deadline back. */
        function armIdleTimer(): void {
            if (settled) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => finish(null), timeoutMs);
        }

        /** A host that never displayed anything — the caller should try the next one. */
        function failLaunch(detail: string): void {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (loadWatchdog) clearTimeout(loadWatchdog);
            server.close();
            child?.kill();
            reject(new PickerHostLaunchError(`${browserPath} failed to launch: ${detail}`));
        }

        function handle(req: IncomingMessage, res: ServerResponse): void {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            // Any local process could reach this port; the token gates every route.
            if (url.searchParams.get("t") !== token) {
                res.writeHead(403).end("forbidden");
                return;
            }

            if (url.pathname === "/") {
                // Proof the host actually launched and rendered something.
                pageServed = true;
                if (loadWatchdog) clearTimeout(loadWatchdog);
                // no-store because the page is regenerated on every add and delete. Without it
                // the reload after a mutation is served from the web view's cache, so the item
                // stays on screen even though it is already gone from settings.
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store, no-cache, must-revalidate",
                    "Pragma": "no-cache",
                }).end(html);
                return;
            }

            if (url.pathname === "/icon") {
                // Only icons named by the caller are servable — no traversal, no arbitrary reads.
                const requested = url.searchParams.get("p") ?? "";
                if (!allowedIcons.has(requested)) {
                    warn(`picker refused an icon outside the declared set: ${requested}`);
                    res.writeHead(404).end("not found");
                    return;
                }
                // Prefer @2x, but fall back to @1x so an icon authored at only one density still
                // appears instead of rendering as blank space.
                void (async () => {
                    for (const suffix of ICON_SUFFIXES) {
                        try {
                            const buf = await readFile(normalize(`${requested}${suffix}`));
                            res.writeHead(200, { "Content-Type": "image/png" }).end(buf);
                            return;
                        } catch {
                            // not readable at this density — try the next
                        }
                    }
                    // Paths are relative, so cwd is the usual culprit and worth recording.
                    warn(`picker found no readable icon for "${requested}" — tried ` +
                         `${ICON_SUFFIXES.join(", ")} relative to ${process.cwd()}`);
                    res.writeHead(404).end("not found");
                })();
                return;
            }

            if (url.pathname === "/message" && req.method === "POST") {
                // The user is still here; push the idle deadline back.
                armIdleTimer();
                let body = "";
                req.on("data", chunk => { body += chunk; });
                req.on("end", () => {
                    let parsed: { type?: unknown; id?: unknown; action?: unknown; message?: unknown; title?: unknown };
                    try {
                        parsed = JSON.parse(body);
                    } catch {
                        // malformed body — treat as a cancel rather than guessing intent
                        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                        finish(null);
                        return;
                    }

                    // Page-side failures, so they reach the plugin log instead of vanishing.
                    if (parsed.type === "error" && typeof parsed.message === "string") {
                        warn(`picker page error: ${parsed.message}`);
                        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                        return;
                    }

                    // Hiding mutates the list and leaves the window open.
                    if (parsed.type === "hide" && typeof parsed.id === "string") {
                        const toggle = options.onToggleHidden;
                        if (!toggle) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                                .end(JSON.stringify({ message: "Not supported" }));
                            return;
                        }
                        toggle(parsed.id)
                            .then(updated => {
                                currentItems = updated;
                                allowedIcons = new Set(
                                    updated.map(i => i.icon).filter((p): p is string => !!p)
                                );
                                html = renderHtml(
                                    currentItems, token, { ...options, title }, options.theme ?? "dark"
                                );
                                res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                            })
                            .catch((error: unknown) => {
                                const message = error instanceof Error ? error.message : "Failed";
                                warn(`picker hide toggle failed: ${message}`);
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify({ message }));
                            });
                        return;
                    }

                    // Rename mutates the list and leaves the window open.
                    if (parsed.type === "rename" && typeof parsed.id === "string"
                        && typeof parsed.title === "string") {
                        const rename = options.onRename;
                        if (!rename) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                                .end(JSON.stringify({ message: "Not supported" }));
                            return;
                        }
                        rename(parsed.id, parsed.title)
                            .then(updated => {
                                currentItems = updated;
                                allowedIcons = new Set(
                                    updated.map(i => i.icon).filter((p): p is string => !!p)
                                );
                                html = renderHtml(
                                    currentItems, token, { ...options, title }, options.theme ?? "dark"
                                );
                                res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                            })
                            .catch((error: unknown) => {
                                const message = error instanceof Error ? error.message : "Failed";
                                warn(`picker rename failed: ${message}`);
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify({ message }));
                            });
                        return;
                    }

                    // Delete mutates the list and leaves the window open, like an action row.
                    if (parsed.type === "delete" && typeof parsed.id === "string") {
                        const remove = options.onDelete;
                        if (!remove) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                                .end(JSON.stringify({ message: "Not supported" }));
                            return;
                        }
                        // Captured before the removal, so the notice can name what went. Taken
                        // from the item rather than the page: this label is already masked for a
                        // hidden clip, so undoing a secret cannot put its value on screen.
                        const goneLabel = currentItems.find(i => i.id === parsed.id)?.label;
                        remove(parsed.id)
                            .then(updated => {
                                currentItems = updated;
                                allowedIcons = new Set(
                                    updated.map(i => i.icon).filter((p): p is string => !!p)
                                );
                                html = renderHtml(
                                    currentItems, token, { ...options, title }, options.theme ?? "dark"
                                );
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify(options.onUndoDelete
                                        ? { undo: true, label: goneLabel }
                                        : {}));
                            })
                            .catch((error: unknown) => {
                                const message = error instanceof Error ? error.message : "Failed";
                                warn(`picker delete failed: ${message}`);
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify({ message }));
                            });
                        return;
                    }

                    // Undo restores the last deletion and leaves the window open.
                    if (parsed.type === "undo") {
                        const undo = options.onUndoDelete;
                        if (!undo) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                                .end(JSON.stringify({ message: "Nothing to undo" }));
                            return;
                        }
                        undo()
                            .then(updated => {
                                currentItems = updated;
                                allowedIcons = new Set(
                                    updated.map(i => i.icon).filter((p): p is string => !!p)
                                );
                                html = renderHtml(
                                    currentItems, token, { ...options, title }, options.theme ?? "dark"
                                );
                                res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                            })
                            .catch((error: unknown) => {
                                const message = error instanceof Error ? error.message : "Failed";
                                warn(`picker undo failed: ${message}`);
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify({ message }));
                            });
                        return;
                    }

                    // An action mutates the list and leaves the window open.
                    if (parsed.type === "action" && typeof parsed.action === "string") {
                        const handler = options.onAction;
                        if (!handler) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                                .end(JSON.stringify({ message: "Not supported" }));
                            return;
                        }
                        handler(parsed.action)
                            .then(updated => {
                                currentItems = updated;
                                allowedIcons = new Set(
                                    updated.map(i => i.icon).filter((p): p is string => !!p)
                                );
                                html = renderHtml(
                                    currentItems, token, { ...options, title }, options.theme ?? "dark"
                                );
                                res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                            })
                            .catch((error: unknown) => {
                                // Report in the window instead of closing it — losing the picker on
                                // a failed add would be a worse outcome than an inline message.
                                const message = error instanceof Error ? error.message : "Failed";
                                warn(`picker action "${parsed.action as string}" failed: ${message}`);
                                res.writeHead(200, { "Content-Type": "application/json" })
                                    .end(JSON.stringify({ message }));
                            });
                        return;
                    }

                    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                    const id = typeof parsed.id === "string" && currentItems.some(i => i.id === parsed.id)
                        ? parsed.id
                        : null;
                    finish(id);
                });
                return;
            }

            res.writeHead(404).end("not found");
        }

        server.on("error", () => finish(null));

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            const target = `http://127.0.0.1:${port}/?t=${token}`;
            child = spawn(browserPath, [
                `--app=${target}`,
                `--window-size=${options.width ?? WINDOW_WIDTH},${options.height ?? WINDOW_HEIGHT}`,
                "--no-first-run",
                "--no-default-browser-check",
            ], { stdio: ["ignore", "ignore", "pipe"], detached: false });

            // Surface the host's stderr. The native host reports its window geometry and any
            // page-load failure there; discarding it would hide exactly the class of problem
            // that is hardest to diagnose from the outside.
            child.stderr?.on("data", chunk => {
                const text = String(chunk).trim();
                if (text) warn(text);
            });

            child.on("error", err => failLaunch(err.message));

            // The host exited before any selection arrived. Exit status separates the two very
            // different reasons:
            //
            //  - code 0: it ran and the window was closed. The page's beforeunload POST normally
            //    reports that first, but it can lose the race, so treat this as a cancellation.
            //    Retrying another host here would pop a second window at the user.
            //  - anything else: it never displayed — a quarantined binary killed by the system,
            //    or bad arguments. Worth trying the next host.
            child.on("exit", (code, signal) => {
                if (settled) return;
                if (code === 0 && !signal) {
                    finish(null);
                } else {
                    failLaunch(signal ? `killed by ${signal}` : `exited with code ${code}`);
                }
            });

            armIdleTimer();
            loadWatchdog = setTimeout(() => {
                if (!pageServed) {
                    failLaunch(`never requested the page within ${PAGE_LOAD_TIMEOUT_MS}ms`);
                }
            }, PAGE_LOAD_TIMEOUT_MS);
        });
    });
}
