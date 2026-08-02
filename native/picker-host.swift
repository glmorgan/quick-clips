import AppKit
import WebKit
import CoreGraphics

//
// picker-host — a minimal native window that displays the Quick Clips transform picker.
//
// This replaces the Chromium `--app=` window. It deliberately does NOT know anything about
// transforms or selections: the page already POSTs its choice to the plugin's local server,
// and the plugin already kills this process once it has an answer or times out. So this
// process only has to be a correctly-sized, correctly-placed window that loads a URL.
//
// It accepts Chrome's own flag spelling (`--app=<url>`, `--window-size=W,H`) so it is a
// drop-in substitute for the browser during evaluation, with no changes to picker.ts.
//
// It also serves a second, unrelated purpose behind `--type-text`: typing arbitrary Unicode
// into the frontmost app. That lives here rather than in its own binary purely so there is one
// executable to build, sign and ship.
//
// Exits non-zero on a bad invocation; exits 0 when the window closes.
//

/// Diagnostics go to stderr so they never contaminate a caller reading stdout.
private func log(_ message: String) {
    FileHandle.standardError.write("picker-host: \(message)\n".data(using: .utf8)!)
}

private func flagValue(_ name: String) -> String? {
    for arg in CommandLine.arguments where arg.hasPrefix("--\(name)=") {
        return String(arg.dropFirst(name.count + 3))
    }
    return nil
}

/**
 * The picker page's own background, mirroring --bg in picker.ts.
 *
 * Every surface that can be seen before the HTML paints is set to this, so the window opens
 * already the right colour. Nothing here may use a dynamic system colour: the page is always
 * dark, while NSColor.windowBackgroundColor resolves to #FFFFFF under the light appearance —
 * which showed as a white flash on a Mac set to Light mode.
 */
private let pageBackground = NSColor(srgbRed: 0x33 / 255.0, green: 0x33 / 255.0, blue: 0x33 / 255.0, alpha: 1)

/// Fraction of leftover vertical space placed above the window; mirrors VERTICAL_BIAS in picker.ts.
private let verticalBias: CGFloat = 0.35
private let defaultSize = CGSize(width: 860, height: 670)

private func requestedContentSize() -> CGSize {
    guard let raw = flagValue("window-size") else { return defaultSize }
    let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return defaultSize }
    return CGSize(width: parts[0], height: parts[1])
}

final class PickerWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var parentWatch: Timer?

    func show(url: URL, contentSize: CGSize) {
        let config = WKWebViewConfiguration()
        // Nothing is persisted between invocations — the picker is stateless.
        config.websiteDataStore = .nonPersistent()

        // Tell the page it is hosted natively so it skips the resizeTo/moveTo dance it needs
        // under Chrome. Those calls exist only because Chrome ignores its geometry flags; here
        // the window is already correct, and a resizeTo() would size the *outer* frame and cost
        // 32px of content. Injected at documentStart so it lands before the page's own scripts.
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__nativeHost = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        webView = WKWebView(frame: NSRect(origin: .zero, size: contentSize), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The page is our own content; a visible bounce/overscroll would look wrong in a panel.
        // This is also the colour shown before the first paint, so it must be the page's own
        // background rather than the system's — see pageBackground.
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = pageBackground }

        // contentRect is the *content* area and AppKit adds the title bar above it, so the page
        // gets exactly the height asked for — no chrome measurement, unlike Chrome where
        // resizeTo() sizes the outer frame and silently eats ~32px of content.
        //
        // .fullSizeContentView is deliberately NOT used: it makes the frame equal contentRect,
        // reintroducing that same 32px shortfall, and would slide the page header under the
        // traffic-light buttons.
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.delegate = self
        window.contentView = webView
        window.title = "Quick Text Utils"
        // Chromeless look while keeping the close button and a draggable region.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.backgroundColor = pageBackground
        // Pins the frame to the dark appearance too. The page is always dark, so leaving this to
        // follow the system drew light traffic lights and a light titlebar over a dark page on a
        // Mac set to Light mode.
        window.appearance = NSAppearance(named: .darkAqua)
        // Float above the app the user was working in, since that app keeps keyboard focus context.
        window.level = .floating
        window.isReleasedWhenClosed = false

        position(window, contentSize: contentSize)
        webView.load(URLRequest(url: url))

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        watchParent()
    }

    /**
     * Exits when the plugin that spawned this window goes away.
     *
     * The page talks to a server owned by the plugin process. If that process restarts or
     * crashes, this window is re-parented to launchd and left on screen with every control
     * silently hitting a dead server — visible, but inert. Nothing else notices: the plugin
     * cannot clean up a child it no longer knows about, and the page has no way to tell a
     * closed server from a slow one.
     */
    private func watchParent() {
        let originalParent = getppid()
        parentWatch = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            if getppid() != originalParent {
                log("plugin process went away; closing")
                NSApp.terminate(nil)
            }
        }
    }

    /// Centres horizontally and biases above centre, matching the browser build's placement.
    private func position(_ window: NSWindow, contentSize: CGSize) {
        // The screen under the mouse, so the picker lands where the user is looking on a
        // multi-monitor setup rather than always on the primary display.
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
        guard let area = screen?.visibleFrame else { window.center(); return }

        let frameSize = window.frame.size  // includes the title bar
        let x = area.midX - frameSize.width / 2
        // AppKit's origin is bottom-left, so a bias measured from the top inverts here.
        let topGap = (area.height - frameSize.height) * verticalBias
        let y = area.maxY - frameSize.height - topGap
        window.setFrameOrigin(NSPoint(x: x.rounded(), y: y.rounded()))

        // Reported so the caller can log where the window actually landed. Placement bugs are
        // otherwise invisible without Accessibility permission to inspect the window externally.
        let f = window.frame
        let c = window.contentLayoutRect
        log("frame \(Int(f.width))x\(Int(f.height)) at \(Int(f.origin.x)),\(Int(f.origin.y)) | "
            + "content \(Int(c.width))x\(Int(c.height)) | screen \(Int(area.width))x\(Int(area.height))")
    }

    func windowWillClose(_ notification: Notification) {
        // The page's beforeunload handler reports the cancellation before we go.
        NSApp.terminate(nil)
    }

    /// The page calls window.close() after sending its selection.
    func webViewDidClose(_ webView: WKWebView) {
        NSApp.terminate(nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error.localizedDescription)")
        NSApp.terminate(nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("could not load page: \(error.localizedDescription)")
        NSApp.terminate(nil)
    }
}

// MARK: - Unicode typing

/**
 * Holds off until the user lets go of any modifier that would turn text into commands.
 *
 * Typing is triggered by a keystroke — Cmd+1..9 picks a clip — and the paste follows within a
 * few tens of milliseconds, while the key is realistically still down. Clearing each event's
 * flags handles what we post; this handles what the receiving app sees of the real keyboard.
 *
 * Bounded, so a stuck or genuinely held modifier delays the text rather than losing it. Shift is
 * not included: it does not turn a character into a command, and waiting on it would stall.
 */
private func waitForModifiersToClear(timeout: useconds_t = 600_000) {
    let blocking: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate]
    let step: useconds_t = 10_000
    var waited: useconds_t = 0
    while !CGEventSource.flagsState(.combinedSessionState).intersection(blocking).isEmpty {
        if waited >= timeout {
            log("modifiers still held after \(timeout / 1000)ms; typing anyway")
            return
        }
        usleep(step)
        waited += step
    }
    if waited > 0 { log("waited \(waited / 1000)ms for modifiers to clear") }
}

/**
 * Types text into the frontmost application by posting Unicode directly.
 *
 * AppleScript's `keystroke` synthesises presses against the current keyboard layout, so any
 * character that layout cannot produce is silently replaced — an arrow, an accented letter,
 * CJK and emoji all arrive as "a". keyboardSetUnicodeString bypasses the layout entirely.
 *
 * Needs the same Accessibility permission `keystroke` already required, so it asks nothing new
 * of the user.
 */
private func typeText(_ text: String) {
    guard !text.isEmpty else { return }
    waitForModifiersToClear()
    let source = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    // Chunked because keyboardSetUnicodeString silently truncates oversized payloads.
    let chunkSize = 16
    var index = 0
    while index < units.count {
        var end = min(index + chunkSize, units.count)
        // Never split a surrogate pair across events, or an emoji arrives as two broken halves.
        if end < units.count, units[end - 1] >= 0xD800, units[end - 1] <= 0xDBFF { end -= 1 }
        let chunk = Array(units[index ..< end])
        for isDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
            else { continue }
            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            // Explicitly unmodified. An event created from a source inherits that source's flag
            // state, and .hidSystemState is the live hardware state — so a key the user is still
            // holding rides along on every character and the receiving app reads them as
            // shortcuts rather than text. Nothing typed here is ever meant to carry a modifier.
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
        index = end
        usleep(1500)
    }
    // Events are delivered asynchronously; exiting immediately drops whatever is still in
    // flight, which silently truncates the tail of the text.
    usleep(120_000)
}

// MARK: - entry point

// Typing mode needs no window, so it must short-circuit before any AppKit setup.
if CommandLine.arguments.contains("--type-text") {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    typeText(String(data: data, encoding: .utf8) ?? "")
    exit(0)
}

guard let raw = flagValue("app"), let url = URL(string: raw), url.scheme != nil else {
    FileHandle.standardError.write("usage: picker-host --app=<url> [--window-size=W,H]\n       picker-host --type-text   (text on stdin)\n".data(using: .utf8)!)
    exit(2)
}

let app = NSApplication.shared
// .accessory, not .regular: a transient picker should not register as a full application. The
// regular policy adds a Dock icon and the whole app-launch ceremony, which is what made opening
// feel like a second or two of loading. Accessory windows can still become key and take
// keyboard focus, which type-to-filter needs.
app.setActivationPolicy(.accessory)

// AppKit routes the standard editing shortcuts through the Edit menu's key equivalents, so
// without a menu bar Cmd+V, Cmd+C and Cmd+A simply do nothing — you could not paste into the
// picker's filter field. A minimal Edit menu restores them; the menu itself is never shown
// because the window is the only UI.
let mainMenu = NSMenu()
let editItem = NSMenuItem()
mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
for (title, selector, key) in [
    ("Cut", #selector(NSText.cut(_:)), "x"),
    ("Copy", #selector(NSText.copy(_:)), "c"),
    ("Paste", #selector(NSText.paste(_:)), "v"),
    ("Select All", #selector(NSText.selectAll(_:)), "a"),
] {
    editMenu.addItem(NSMenuItem(title: title, action: selector, keyEquivalent: key))
}
editItem.submenu = editMenu
app.mainMenu = mainMenu

let controller = PickerWindowController()
controller.show(url: url, contentSize: requestedContentSize())
app.run()
