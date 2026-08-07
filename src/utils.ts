import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export type TransformType = 'upper' | 'lower' | 'titlecase' | 'camelCase' | 'dashcase' | 'snakecase' | 'trim' | 'urlencode' | 'urldecode' | 'base64encode' | 'base64decode' | 'count' | 'uuid' | 'dateiso' | 'datetimeiso' | 'unixtime' | 'unixtimems';

/**
 * Transforms that produce their own output and ignore the incoming text. Callers must not
 * treat an empty clipboard as an error for these.
 */
const GENERATORS: ReadonlySet<TransformType> = new Set<TransformType>([
    'uuid', 'dateiso', 'datetimeiso', 'unixtime', 'unixtimems',
]);

export function isGenerator(transform: TransformType): boolean {
    return GENERATORS.has(transform);
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * Formats the *local* calendar date as `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which formats in UTC and therefore reports
 * the wrong day for anyone whose local date differs from UTC's at the time of use.
 */
function localDate(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Formats the local wall-clock time as `HH:mm:ss`. */
function localTime(d: Date): string {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function applyTransform(text: string, transform: TransformType): string {
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
            return text;
        case 'uuid':
            // Generator, not a transform — ignores the incoming text
            return randomUUID();
        case 'dateiso':
            return localDate(new Date());
        case 'datetimeiso': {
            // One Date instance so the date and time cannot straddle a midnight rollover
            const now = new Date();
            return `${localDate(now)}T${localTime(now)}`;
        }
        case 'unixtime':
            // POSIX time: whole seconds since the epoch, as `date +%s` and JWT claims use
            return String(Math.floor(Date.now() / 1000));
        case 'unixtimems':
            // Milliseconds, matching JavaScript's Date.now() and most JSON APIs
            return String(Date.now());
    }
}

/**
 * Escapes text for embedding in an AppleScript double-quoted string literal.
 *
 * AppleScript treats `\` as an escape character inside strings, so unescaped input
 * containing backslashes (Windows paths, regexes, escaped JSON, LaTeX) is either
 * mangled or fails to compile. Newlines are converted to escape sequences so the
 * generated script always stays on a single line — a raw CR would otherwise
 * terminate the statement.
 *
 * Order matters: backslashes must be doubled before any other escape is introduced.
 */
export function escapeForAppleScript(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

/** A single stored clip inside a Quick Clips Manager collection. */
export type ClipEntry = {
    /** Stable id, so reordering never invalidates a pending selection. */
    id: string;
    /**
     * Masks the value in the picker. **Hiding, not securing** — the value remains in plain text
     * in the Stream Deck profile, and pasting still yields it verbatim. This defends against
     * someone reading your screen, and nothing else.
     */
    hidden?: boolean;
    /**
     * User-supplied name, e.g. "P1 Client Id".
     *
     * Separate from {@link label} so a name the user chose is never overwritten by a
     * regenerated summary, and so clearing it falls back to describing the value again.
     */
    title?: string;
    /** The exact text, preserved verbatim including whitespace. */
    value: string;
    addedAt: number;
    /**
     * When the clip was last pasted. Recorded but never used for ordering — the list keeps a
     * stable position for every clip so numbered shortcuts and muscle memory stay valid. This
     * exists only so the cap evicts the clip nobody uses rather than merely the oldest one.
     */
    lastUsedAt?: number;
};

/**
 * Caps on a collection. Settings are JSON persisted into the Stream Deck profile, so an
 * unbounded collection would bloat it; these keep a profile a sane size while being far
 * larger than the handful of entries a project realistically needs.
 */
export const MAX_CLIPS = 50;
export const MAX_CLIP_CHARS = 10_000;
/**
 * Upper bound on a summary, not a display width.
 *
 * The picker truncates with CSS ellipsis, which adapts to the actual row width; a character cap
 * that bites first just discards text the window had room for, and makes clips sharing a long
 * prefix indistinguishable. This is only here so a pathological clip cannot produce a
 * megabyte-long label.
 */
const SUMMARY_MAX_CHARS = 400;

/**
 * Renders a clip as a single line for the picker.
 *
 * Distinct from {@link generateLabel}, which targets a 7-character Stream Deck key title;
 * the picker has far more room, and collapsing newlines matters more than fitting a key.
 */
export function summarizeClip(value: string, maxChars: number = SUMMARY_MAX_CHARS): string {
    const flat = value.replace(/\s+/g, " ").trim();
    if (flat === "") return "(blank)";
    return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * How confident the secret check is, kept in the type so the two can never be conflated.
 *
 * `identified` means a rule recognised the value's format — a published token prefix, a JWT that
 * decodes, a URL carrying a password. `heuristic` means nothing recognised it and only its shape
 * suggested it. They have earned very different amounts of trust, and presenting them
 * identically would invite the user to trust both equally.
 */
export type SecretConfidence = "identified" | "heuristic" | "none";

export type SecretVerdict = {
    secret: boolean;
    confidence: SecretConfidence;
    /** What matched, phrased for a person. */
    reason: string;
    /**
     * A short name for the clip, used when auto-masking one that has none.
     *
     * Masking costs a clip its searchability — {@link clipSearchText} returns the title alone for
     * a hidden clip, deliberately, so typing a secret cannot highlight its row. An unnamed masked
     * clip is therefore findable by nothing, and renders as the same twelve dots as every other
     * one. A generated name restores both, and is plainly a default the user can replace.
     */
    title?: string;
};

/**
 * Token prefixes their vendors publish so that scanners can match them, which is exactly why
 * they do not misfire. Order is irrelevant; none of these overlap.
 */
const SECRET_PATTERNS: [RegExp, string, string][] = [
    [/\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/, "GitHub token", "looks like a GitHub token"],
    [/\bglpat-[A-Za-z0-9_-]{20,}/, "GitLab token", "looks like a GitLab token"],
    [/\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/, "Stripe secret key", "looks like a Stripe secret key"],
    [/\bxox[bpasr]-[A-Za-z0-9-]{10,}/, "Slack token", "looks like a Slack token"],
    [/\b(AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[A-Z0-9]{16}\b/, "AWS access key", "looks like an AWS access key id"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key", "looks like a Google API key"],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key", "looks like an Anthropic API key"],
    [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token", "looks like an npm token"],
    [/\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}/, "SendGrid key", "looks like a SendGrid key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "Private key", "looks like a private key"],
    // Context, not shape. A token copied out of devtools or a curl command arrives wrapped in
    // its header, and the space in it defeats the shape heuristic — so without these, adding
    // the context that proves it is a credential made it *less* likely to be masked.
    [/\bproxy-authorization\s*:\s*\S/i, "Authorization header", "is a Proxy-Authorization header"],
    [/\bauthorization\s*:\s*\S/i, "Authorization header", "is an Authorization header"],
    [/\bbearer\s+[A-Za-z0-9\-._~+/]{12,}=*/i, "Bearer token", "carries a bearer token"],
];

/**
 * A value assigned to a name that means "credential".
 *
 * The name is the signal, so the generated title can safely reuse it — a field called
 * `x-api-key` gives away nothing the mask was hiding. The value must be at least 12 characters
 * with no whitespace, which is what keeps prose out: "password: 8 characters minimum" does not
 * match, while `"api_key": "abcdefghijklmnop"` does.
 *
 * Underscores and hyphens count as separators before the name, so DATABASE_PASSWORD= is
 * identified rather than falling through to the shape heuristic and being called an opaque
 * token — the same outcome, but with a name that says what it is.
 */
const CREDENTIAL_ASSIGNMENT =
    /(?:^|[\s{,"'(<_-])(x-api-key|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?token|access[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{12,})/i;

/** `user:password`, which is what a Basic credential decodes to. */
const USERINFO = /^[^\s:]{1,64}:[^\s]{1,256}$/;

/** Shannon entropy per character. Hex cannot exceed 4 bits, which is what excludes hashes. */
function shannonEntropy(text: string): number {
    const freq = new Map<string, number>();
    for (const c of text) freq.set(c, (freq.get(c) ?? 0) + 1);
    let bits = 0;
    for (const n of freq.values()) {
        const pr = n / text.length;
        bits -= pr * Math.log2(pr);
    }
    return bits;
}

/**
 * Decoded text, when the value is base64 of something readable — encoded data rather than an
 * opaque secret. Returns null otherwise, so callers can inspect what it decoded to.
 *
 * Without this, base64 of ordinary configuration scores ~4.8 bits/char and trips the shape
 * heuristic. A base64-encoded *key* decodes to random bytes and still gets flagged.
 */
function decodeBase64Text(text: string): string | null {
    if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(text)) return null;
    try {
        const decoded = Buffer.from(text, "base64").toString("utf8");
        if (decoded.length < 8) return null;
        const printable = [...decoded].filter(c => c >= " " && c <= "~").length;
        return printable / decoded.length > 0.9 ? decoded : null;
    } catch {
        return null;
    }
}

/**
 * Decides whether a value looks like a credential, so it can be masked on capture.
 *
 * **This recognises a few well-known shapes. It does not detect secrets.** A short password, an
 * internal token with no distinguishing format, anything under 32 characters — all pass straight
 * through. Treat a negative as "nothing matched", never as "this is safe".
 *
 * Ordered deliberately, and the order is doing real work:
 *
 *  1. explicit allows first, so a Stripe *publishable* key is never masked for looking random —
 *     it is meant to be public, and masking it would be actively wrong
 *  2. then rules that identify what the value *is*
 *  3. then a second allow for base64 of readable text
 *  4. only then the shape heuristic, which is a guess and is labelled as one
 *
 * Measured against a corpus of look-alikes: UUIDs, git SHAs and every hex hash sit below the
 * entropy threshold on their own, because hex caps at 4 bits per character.
 */
export function classifySecret(value: string): SecretVerdict {
    const text = value.trim();
    if (text === "") return { secret: false, confidence: "none", reason: "empty" };

    if (/\bpk_(live|test)_/.test(text)) {
        return { secret: false, confidence: "none", reason: "a publishable key, which is meant to be public" };
    }
    for (const [pattern, title, reason] of SECRET_PATTERNS) {
        if (pattern.test(text)) return { secret: true, confidence: "identified", reason, title };
    }
    if (isJwt(text)) {
        return { secret: true, confidence: "identified", reason: "looks like a JWT", title: "JWT" };
    }
    try {
        if (new URL(text).password !== "") {
            return {
                secret: true, confidence: "identified",
                reason: "carries a password in the URL", title: "URL with password",
            };
        }
    } catch {
        // not a URL — carry on
    }
    const decoded = decodeBase64Text(text);
    if (decoded !== null) {
        // Checked before the allow below, which would otherwise clear it: a Basic credential is
        // base64 of perfectly readable text, and that text is a username and password.
        if (USERINFO.test(decoded)) {
            return {
                secret: true, confidence: "identified",
                reason: "decodes to a username and password", title: "Basic credential",
            };
        }
        return { secret: false, confidence: "none", reason: "base64 of readable text" };
    }
    const assigned = text.match(CREDENTIAL_ASSIGNMENT);
    if (assigned) {
        return {
            secret: true, confidence: "identified",
            reason: `assigns a value to "${assigned[1]}"`, title: assigned[1],
        };
    }
    if (text.length >= 32 && text.length <= 400 && !/\s/.test(text) && shannonEntropy(text) >= 4.5) {
        return {
            secret: true, confidence: "heuristic",
            reason: "is a long opaque string that looks random", title: "Opaque token",
        };
    }
    return { secret: false, confidence: "none", reason: "nothing matched" };
}

/**
 * Masks a freshly captured clip and names it, when the check says it is a credential.
 *
 * The name is only generated when the user has not supplied one, and is deliberately generic —
 * "GitHub token" rather than anything drawn from the value — so a glance at the screen learns
 * nothing the mask was meant to withhold.
 */
export function applySecretVerdict(
    clips: readonly ClipEntry[],
    id: string,
    verdict: SecretVerdict
): ClipEntry[] {
    if (!verdict.secret) return [...clips];
    return clips.map(c => {
        if (c.id !== id) return c;
        const existing = c.title?.trim();
        const title = existing ? existing : verdict.title;
        return { ...c, hidden: true, ...(title ? { title } : {}) };
    });
}

/** Broad shape of a clip, used to badge rows in the picker. */
export type ClipKind =
    | "json" | "url" | "path" | "email" | "uuid"
    | "jwt" | "color" | "ip" | "date" | "text";

/**
 * True when the value is a JSON Web Token.
 *
 * Checked by decoding the header and requiring it to be a JSON object with an `alg`, rather than
 * matching the dot-separated shape — plenty of strings have two dots in them.
 */
function isJwt(value: string): boolean {
    const parts = value.split(".");
    if (parts.length !== 3) return false;
    // Header and payload must be base64url; the signature may legitimately be empty for alg=none.
    if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
    try {
        const header: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        return typeof header === "object" && header !== null
            && typeof (header as { alg?: unknown }).alg === "string";
    } catch {
        return false;
    }
}

/**
 * True for an ISO 8601 date or timestamp.
 *
 * The calendar values are checked, not just the digit pattern, so `2026-13-45` and `2026-02-30`
 * are rejected rather than badged as dates.
 */
function isIsoDateTime(value: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
        .exec(value);
    if (!m) return false;
    const [, y, mo, d, hh, mm, ss] = m;
    if (hh !== undefined && (+hh > 23 || +mm > 59 || (ss !== undefined && +ss > 60))) return false;
    // Round-tripping through Date rejects impossible calendar days such as 31 February.
    const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
    return date.getUTCFullYear() === +y
        && date.getUTCMonth() + 1 === +mo
        && date.getUTCDate() === +d;
}

/**
 * Classifies a clip by shape.
 *
 * Every rule here is checkable rather than a guess — JSON is *parsed*, not pattern-matched, and
 * the rest require the whole value to be a single token of that form. A clip merely *containing*
 * a URL is prose, not a link.
 *
 * There is deliberately no "code" kind: nothing distinguishes code reliably (braces appear in
 * JSON, prose contains keywords, shell one-liners have neither), and a badge that is wrong often
 * enough to doubt makes every other badge untrustworthy too.
 */
export function detectClipKind(value: string): ClipKind {
    const trimmed = value.trim();
    if (trimmed === "") return "text";

    // Parsed, not guessed. Restricted to objects and arrays so bare numbers and quoted
    // strings — which are also valid JSON — are not badged as structured data.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed !== null && typeof parsed === "object") return "json";
        } catch {
            // not JSON after all — fall through to the remaining shapes
        }
    }

    // Canonical 8-4-4-4-12 hex form, any version. Deliberately not restricted to v4: a v1 or v7
    // identifier pasted from elsewhere is still a UUID, and labelling it "Text" would be wrong.
    // Braced and urn:uuid: variants are excluded as vanishingly rare on a clipboard.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return "uuid";
    }

    if (isJwt(trimmed)) return "jwt";

    // Single-token forms only; anything with internal whitespace is prose that happens to
    // mention a URL or an address.
    if (/^https?:\/\/\S+$/i.test(trimmed)) return "url";

    // #RGB, #RGBA, #RRGGBB and #RRGGBBAA.
    if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) return "color";

    // node:net validates octet ranges and IPv6 properly, so `999.1.1.1` is correctly refused —
    // something a dotted-quad regex would happily accept.
    if (isIP(trimmed) !== 0) return "ip";

    if (isIsoDateTime(trimmed)) return "date";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "email";

    // Paths may contain spaces, so only the prefix is required — but a single line is, since a
    // multi-line blob starting with "/" is a document rather than a path.
    if (!trimmed.includes("\n") && /^(~\/|\/|[A-Za-z]:\\)/.test(trimmed)) return "path";

    return "text";
}

/**
 * Returns a new collection with `value` added, newest first.
 *
 * Adding text already present moves the existing entry to the top rather than creating a
 * duplicate, so repeatedly grabbing the same snippet keeps it handy instead of filling the
 * list. Whitespace-only input is rejected — capturing an accidental empty clipboard is never
 * intended. Over-long text is refused rather than truncated, since a silently clipped snippet
 * would paste corrupt content.
 */
export function addClip(
    clips: readonly ClipEntry[],
    value: string,
    id: string,
    now: number
): { clips: ClipEntry[]; added: boolean; reason?: "empty" | "too-long" } {
    if (value.trim() === "") return { clips: [...clips], added: false, reason: "empty" };
    if (value.length > MAX_CLIP_CHARS) return { clips: [...clips], added: false, reason: "too-long" };

    const existing = clips.find(c => c.value === value);
    const rest = clips.filter(c => c.value !== value);
    const entry: ClipEntry = existing
        ? { ...existing }
        : { id, value, addedAt: now };

    const combined = [entry, ...rest];
    if (combined.length <= MAX_CLIPS) return { clips: combined, added: true };

    // Over the cap. Dropping the tail would discard by age alone, so a clip stored first and
    // pasted daily would go before one added later and never touched. Position no longer tracks
    // use, so the least-recently-used entry has to be found rather than read off the end. The
    // clip just captured is never a candidate.
    let victim = 1;
    for (let i = 2; i < combined.length; i++) {
        if (lastTouched(combined[i]) <= lastTouched(combined[victim])) victim = i;
    }
    return { clips: combined.filter((_, i) => i !== victim), added: true };
}

/** When a clip was last pasted, falling back to when it was captured. */
function lastTouched(clip: ClipEntry): number {
    return clip.lastUsedAt ?? clip.addedAt;
}

/**
 * Records that a clip was pasted, leaving the collection's order alone.
 *
 * Using a clip deliberately does not move it. The list is a curated set of references rather
 * than a history, so a stable position is what makes it learnable — and the numbered shortcuts
 * would otherwise mean something different after every paste.
 */
export function markClipUsed(
    clips: readonly ClipEntry[],
    id: string,
    now: number
): ClipEntry[] {
    return clips.map(c => (c.id === id ? { ...c, lastUsedAt: now } : c));
}

/**
 * Applies an edit to a clip's title and text at once.
 *
 * Position, id, capture time and masking all survive — editing a clip is a correction, and
 * nothing about it should move the clip. What the row shows follows from the new text, since
 * every display path derives from the value rather than from anything stored alongside it.
 *
 * Refuses instead of silently breaking an invariant: `duplicate` when another clip already holds
 * that exact text, which {@link addClip} otherwise guarantees cannot happen, and the same empty
 * and over-long limits a capture is held to.
 */
export function updateClip(
    clips: readonly ClipEntry[],
    id: string,
    next: { title: string; value: string }
): {
    clips: ClipEntry[];
    updated: boolean;
    reason?: "missing" | "empty" | "too-long" | "duplicate";
} {
    const unchanged = () => [...clips];
    if (!clips.some(c => c.id === id)) return { clips: unchanged(), updated: false, reason: "missing" };
    if (next.value.trim() === "") return { clips: unchanged(), updated: false, reason: "empty" };
    if (next.value.length > MAX_CLIP_CHARS) {
        return { clips: unchanged(), updated: false, reason: "too-long" };
    }
    if (clips.some(c => c.id !== id && c.value === next.value)) {
        return { clips: unchanged(), updated: false, reason: "duplicate" };
    }

    const title = next.title.trim();
    return {
        clips: clips.map(c => {
            if (c.id !== id) return c;
            const { title: _dropped, ...rest } = c;
            const edited: ClipEntry = { ...rest, value: next.value };
            return title === "" ? edited : { ...edited, title };
        }),
        updated: true,
    };
}

/**
 * Drops fields that are no longer part of the model, so a stored collection catches up.
 *
 * `label` held a summary of the value that nothing ever read — every display path derives from
 * the value at render time, deliberately, so a row uses the window's real width rather than a
 * cap fixed when the clip was captured. Keeping it cost roughly a third of the stored size and,
 * for a masked clip, wrote the secret into the profile twice.
 *
 * Named fields only, never "drop what I do not recognise": a collection written by a newer
 * version must survive an older one reading it.
 */
export function normaliseClips(
    clips: readonly ClipEntry[]
): { clips: ClipEntry[]; changed: boolean } {
    let changed = false;
    const next = clips.map(clip => {
        if (!("label" in clip)) return clip;
        changed = true;
        const { label: _dropped, ...rest } = clip as ClipEntry & { label?: string };
        return rest;
    });
    return { clips: next, changed };
}

/** The name to show for a clip: the user's title when set, otherwise a summary of the value. */
export function clipDisplayName(clip: ClipEntry): string {
    return clip.title?.trim() || summarizeClip(clip.value);
}

/**
 * Splits a URL into its host and the remainder, for display. Returns null for anything that
 * is not a whole-value URL.
 *
 * The host is the part you recognise a link by, and it is the part a favicon would have
 * conveyed — without any network request, and so without announcing your clipboard to that
 * host or risking a GET against a one-time link.
 */
export function splitUrl(value: string): { host: string; rest: string } | null {
    if (detectClipKind(value) !== "url") return null;
    try {
        const url = new URL(value.trim());
        const rest = `${url.pathname}${url.search}${url.hash}`;
        // `host` rather than `hostname` so a port stays visible — localhost:8080 and
        // localhost:5432 are different things worth telling apart.
        return { host: url.host, rest: rest === "/" ? "" : rest };
    } catch {
        return null;
    }
}

/**
 * The two pieces of text a picker row shows: the identifying name, and the detail beside it.
 *
 * A user title always wins. Otherwise a URL is split so the host acts as the name, which makes
 * a list of links scannable; everything else falls back to summarising the value, where the
 * value *is* the identifier and a second piece would only repeat it.
 */
export function clipRowText(clip: ClipEntry): { label: string; detail?: string } {
    const title = clip.title?.trim();

    // A hidden clip shows only its name; the value is replaced wholesale rather than
    // abbreviated, and an unnamed one falls back to the mask so nothing leaks from the label.
    if (clip.hidden) return { label: title || MASK, detail: title ? MASK : undefined };

    if (title) return { label: title, detail: summarizeClip(clip.value, 160) };

    const url = splitUrl(clip.value);
    if (url) return { label: url.host, detail: url.rest || undefined };

    return { label: summarizeClip(clip.value) };
}

/**
 * Words the filter should match for a clip.
 *
 * A hidden clip is searchable by its name only — matching on the value would highlight the row
 * as you typed the secret, which defeats the point of masking it.
 */
export function clipSearchText(clip: ClipEntry): string {
    const title = clip.title?.trim() ?? "";
    return clip.hidden ? title : `${title} ${clip.value}`.trim();
}

/** Fixed-width mask. Deliberately not the value's length, which would leak how long it is. */
const MASK = "•".repeat(12);

/** Toggles whether a clip's value is masked in the picker. */
export function toggleClipHidden(clips: readonly ClipEntry[], id: string): ClipEntry[] {
    return clips.map(c => {
        if (c.id !== id) return c;
        if (c.hidden) {
            const { hidden: _was, ...rest } = c;
            return rest;
        }
        return { ...c, hidden: true };
    });
}

/** Returns a new collection without the given id. */
export function removeClip(clips: readonly ClipEntry[], id: string): ClipEntry[] {
    return clips.filter(c => c.id !== id);
}

/**
 * Puts a deleted clip back where it was, for undo.
 *
 * Restores by position rather than to the front. Deleting is a single click on a small target
 * with no confirmation, so the common undo is taking back a misaimed one — and that should
 * leave the collection exactly as it was. The index is clamped, since adds and deletes may have
 * moved things in the meantime.
 *
 * Refuses rather than forcing the entry in, so an undo can never destroy something else:
 * `duplicate` when the value is already back (a second undo, or the same text re-captured),
 * `full` when the collection has since filled up and inserting would push out the oldest clip.
 */
export function restoreClip(
    clips: readonly ClipEntry[],
    clip: ClipEntry,
    index: number
): { clips: ClipEntry[]; restored: boolean; reason?: "duplicate" | "full" } {
    if (clips.some(c => c.id === clip.id || c.value === clip.value)) {
        return { clips: [...clips], restored: false, reason: "duplicate" };
    }
    if (clips.length >= MAX_CLIPS) {
        return { clips: [...clips], restored: false, reason: "full" };
    }
    const next = [...clips];
    next.splice(Math.max(0, Math.min(index, clips.length)), 0, clip);
    return { clips: next, restored: true };
}

export function generateLabel(text: string): string {
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const maxCharsPerLine = 7;
    const maxTotalChars = maxCharsPerLine * 2;

    if (cleanText.length <= maxCharsPerLine) {
        return cleanText;
    } else if (cleanText.length <= maxTotalChars) {
        let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);
        if (breakPoint === -1 || breakPoint < 3) breakPoint = maxCharsPerLine;
        return `${cleanText.substring(0, breakPoint).trim()}\n${cleanText.substring(breakPoint).trim()}`;
    } else {
        const line2MaxChars = maxCharsPerLine - 1;
        let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);
        if (breakPoint === -1 || breakPoint < 3) breakPoint = maxCharsPerLine;
        const line1 = cleanText.substring(0, breakPoint).trim();
        let line2 = cleanText.substring(breakPoint).trim();
        if (line2.length > line2MaxChars) {
            const line2Break = line2.lastIndexOf(' ', line2MaxChars);
            line2 = line2Break > 3 ? line2.substring(0, line2Break).trim() : line2.substring(0, line2MaxChars);
        }
        return `${line1}\n${line2}…`;
    }
}
