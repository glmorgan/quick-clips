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
    /** Path to a PNG relative to the sdPlugin root, e.g. `imgs/actions/utils/upper`. */
    icon: string;
    /** Hex accent used for the selected-card outline; should match the icon's own accent bar. */
    accent?: string;
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
    /** Abandon the picker and resolve `null` after this many ms. */
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

const DEFAULT_TIMEOUT_MS = 60_000;
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

function renderHtml(
    items: PickerItem[],
    token: string,
    options: Required<Pick<PickerOptions, "title">> & PickerOptions,
    theme: "auto" | "dark" | "light"
): string {
    const { title, subtitle, selectedId } = options;

    const groups = [...new Set(items.map(i => i.group))];
    const sections = groups.map(group => {
        const cards = items
            .filter(i => i.group === group)
            .map(item => `
        <button class="card${item.id === selectedId ? " is-current" : ""}" role="option"
                data-id="${escapeHtml(item.id)}"
                data-label="${escapeHtml(item.label)}"
                data-search="${escapeHtml((item.label + " " + item.group).toLowerCase())}"
                ${item.id === selectedId ? 'title="Currently set on this button"' : ""}
                style="--accent:${escapeHtml(item.accent ?? DEFAULT_ACCENT)}">
          <img class="icon" src="/icon?t=${token}&p=${encodeURIComponent(item.icon)}" alt="" />
          <span class="label">${escapeHtml(item.label)}</span>
        </button>`)
            .join("");
        return `<section><h2>${escapeHtml(group)}</h2><div class="grid">${cards}</div></section>`;
    }).join("");

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
<html lang="en"${theme === "auto" ? "" : ` data-theme="${theme}"`}>
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
  var W = ${WINDOW_WIDTH}, H = ${WINDOW_HEIGHT};
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
    padding: 18px 0 0;
  }
  .titles { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.015em; }
  .sub { font-size: 12px; color: var(--fg-dim); }

  .searchbar {
    display: flex; align-items: center; gap: 9px;
    margin: 12px 0 0; padding: 0 0 13px;
  }
  .searchbar svg { flex: 0 0 15px; color: var(--fg-faint); }
  #q {
    flex: 1 1 auto; min-width: 0; border: 0; background: transparent; color: var(--fg);
    font: 400 14px/1.3 inherit; letter-spacing: -.01em; outline: none; padding: 0;
  }
  #q::placeholder { color: var(--fg-faint); }
  #count { flex: 0 0 auto; font-size: 11px; color: var(--fg-faint); font-variant-numeric: tabular-nums; }

  main { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 18px; }
  main::-webkit-scrollbar { width: 10px; }
  main::-webkit-scrollbar-thumb {
    background: var(--kbd); border-radius: 99px;
    border: 3px solid transparent; background-clip: content-box;
  }

  section { margin-top: 16px; }
  section.hidden { display: none; }
  h2 {
    margin: 0 0 8px; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--fg-faint);
  }

  .grid {
    display: grid; gap: 9px;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }

  .card {
    position: relative; display: flex; align-items: center; gap: 10px;
    padding: 11px 12px; min-width: 0;
    border: 2px solid var(--card-line); border-radius: 11px;
    background: var(--card); color: inherit; text-align: left;
    font: inherit; cursor: pointer; box-shadow: var(--shadow);
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

  .label {
    flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 550;
    letter-spacing: -.008em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
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
      <input id="q" type="text" placeholder="Filter transforms…" autocomplete="off"
             spellcheck="false" autofocus role="combobox" aria-expanded="true" />
      <span id="count"></span>
    </div>
  </div>
</header>
<main role="listbox">
  <div class="wrap">
    ${sections}
    <div id="empty">
      <div class="big">No matching transform</div>
      <div class="small">Try a different search</div>
    </div>
  </div>
</main>
<footer>
  <div class="wrap">
    <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> navigate</span>
    <span><kbd>↵</kbd> select</span>
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

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function visible() {
    return cards.filter(function (c) { return !c.classList.contains('hidden'); });
  }

  /** Re-renders the label with the matched substring wrapped in <mark>. */
  function highlight(card, term) {
    var label = card.dataset.label;
    var el = card.querySelector('.label');
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
    count.textContent = vis.length === cards.length ? '' : vis.length + ' of ' + cards.length;
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
    fetch('/select?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
      keepalive: true
    }).catch(function () {}).then(function () { window.close(); });
  }

  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase();
    cards.forEach(function (c) {
      c.classList.toggle('hidden', term !== '' && c.dataset.search.indexOf(term) === -1);
      highlight(c, term);
    });
    active = 0;
    paint();
  });

  document.addEventListener('keydown', function (e) {
    var vis = visible();
    if (e.key === 'ArrowRight') { e.preventDefault(); active = Math.min(active + 1, vis.length - 1); paint(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveVertical(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveVertical(-1); }
    else if (e.key === 'Home') { e.preventDefault(); active = 0; paint(); }
    else if (e.key === 'End') { e.preventDefault(); active = vis.length - 1; paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (vis[active]) send(vis[active].dataset.id); }
    else if (e.key === 'Escape') { e.preventDefault(); send(null); }
  });

  cards.forEach(function (card) {
    card.addEventListener('click', function () { send(card.dataset.id); });
    card.addEventListener('mousemove', function () {
      var at = visible().indexOf(card);
      if (at !== -1 && at !== active) { active = at; paint(); }
    });
  });

  window.addEventListener('beforeunload', function () { if (!sent) send(null); });

  // Open on the button's current setting so reconfiguring starts from where it is now.
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
    const html = renderHtml(items, token, { ...options, title }, options.theme ?? "dark");
    const allowedIcons = new Set(items.map(i => i.icon));
    const warn = options.onWarn ?? (() => { /* caller opted out of diagnostics */ });

    return new Promise<string | null>((resolve, reject) => {
        let settled = false;
        let child: ChildProcess | undefined;
        let timer: NodeJS.Timeout | undefined;

        const server = createServer(handle);

        function finish(result: string | null): void {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            server.close();
            // The app window owns no other tabs, so terminating it is safe.
            child?.kill();
            resolve(result);
        }

        /** A host that never displayed anything — the caller should try the next one. */
        function failLaunch(detail: string): void {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
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
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
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

            if (url.pathname === "/select" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => { body += chunk; });
                req.on("end", () => {
                    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
                    let id: string | null = null;
                    try {
                        const parsed = JSON.parse(body) as { id?: unknown };
                        if (typeof parsed.id === "string" && items.some(i => i.id === parsed.id)) {
                            id = parsed.id;
                        }
                    } catch {
                        // malformed body — treat as a cancel
                    }
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
                `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
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

            timer = setTimeout(() => finish(null), timeoutMs);
        });
    });
}
