import { describe, it, expect, vi, afterEach } from "vitest";
import {
    addClip, applyTransform, escapeForAppleScript, generateLabel, isGenerator,
    promoteClip, removeClip, renameClip, clipDisplayName, clipRowText, clipSearchText,
    toggleClipHidden, splitUrl,
    summarizeClip, detectClipKind,
    MAX_CLIPS, MAX_CLIP_CHARS, type ClipEntry,
} from "./utils.js";
import { isKeystrokeSafe } from "./typing.js";

describe("applyTransform", () => {
    describe("upper", () => {
        it("converts to uppercase", () => expect(applyTransform("hello world", "upper")).toBe("HELLO WORLD"));
        it("handles already uppercase", () => expect(applyTransform("HELLO", "upper")).toBe("HELLO"));
    });

    describe("lower", () => {
        it("converts to lowercase", () => expect(applyTransform("Hello World", "lower")).toBe("hello world"));
    });

    describe("titlecase", () => {
        it("capitalizes each word", () => expect(applyTransform("hello world", "titlecase")).toBe("Hello World"));
        it("lowercases rest of word", () => expect(applyTransform("hELLO wORLD", "titlecase")).toBe("Hello World"));
    });

    describe("camelCase", () => {
        it("converts space-separated words", () => expect(applyTransform("hello world", "camelCase")).toBe("helloWorld"));
        it("converts dash-separated words", () => expect(applyTransform("hello-world", "camelCase")).toBe("helloWorld"));
        it("converts underscore-separated words", () => expect(applyTransform("hello_world", "camelCase")).toBe("helloWorld"));
        it("handles single word", () => expect(applyTransform("hello", "camelCase")).toBe("hello"));
    });

    describe("dashcase", () => {
        it("converts spaces to dashes", () => expect(applyTransform("hello world", "dashcase")).toBe("hello-world"));
        it("converts underscores to dashes", () => expect(applyTransform("hello_world", "dashcase")).toBe("hello-world"));
        it("lowercases text", () => expect(applyTransform("Hello World", "dashcase")).toBe("hello-world"));
    });

    describe("snakecase", () => {
        it("converts spaces to underscores", () => expect(applyTransform("hello world", "snakecase")).toBe("hello_world"));
        it("converts dashes to underscores", () => expect(applyTransform("hello-world", "snakecase")).toBe("hello_world"));
        it("lowercases text", () => expect(applyTransform("Hello World", "snakecase")).toBe("hello_world"));
    });

    describe("trim", () => {
        it("removes leading and trailing whitespace", () => expect(applyTransform("  hello  ", "trim")).toBe("hello"));
        it("leaves middle whitespace intact", () => expect(applyTransform("  hello world  ", "trim")).toBe("hello world"));
    });

    describe("urlencode", () => {
        it("encodes special characters", () => expect(applyTransform("hello world", "urlencode")).toBe("hello%20world"));
        it("encodes ampersands and equals", () => expect(applyTransform("foo=bar&baz=qux", "urlencode")).toBe("foo%3Dbar%26baz%3Dqux"));
    });

    describe("urldecode", () => {
        it("decodes encoded characters", () => expect(applyTransform("hello%20world", "urldecode")).toBe("hello world"));
        it("roundtrips with urlencode", () => {
            const original = "foo=bar&baz=qux";
            expect(applyTransform(applyTransform(original, "urlencode"), "urldecode")).toBe(original);
        });
    });

    describe("base64encode", () => {
        it("encodes text", () => expect(applyTransform("hello", "base64encode")).toBe("aGVsbG8="));
    });

    describe("base64decode", () => {
        it("decodes base64", () => expect(applyTransform("aGVsbG8=", "base64decode")).toBe("hello"));
        it("roundtrips with base64encode", () => {
            const original = "hello world";
            expect(applyTransform(applyTransform(original, "base64encode"), "base64decode")).toBe(original);
        });
    });

    describe("count", () => {
        it("returns text unchanged", () => expect(applyTransform("hello world", "count")).toBe("hello world"));
    });

    describe("uuid", () => {
        const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

        it("generates a canonical v4 UUID", () => expect(applyTransform("", "uuid")).toMatch(V4));
        it("ignores the input text", () => expect(applyTransform("hello world", "uuid")).toMatch(V4));
        it("generates a different value each call", () => {
            const values = new Set(Array.from({ length: 100 }, () => applyTransform("", "uuid")));
            expect(values.size).toBe(100);
        });
    });
});

describe("date generators", () => {
    afterEach(() => vi.useRealTimers());

    // Constructed from local components, so the expected strings hold in any timezone.
    const FIXED = new Date(2026, 6, 29, 9, 52, 44);
    const freeze = () => { vi.useFakeTimers(); vi.setSystemTime(FIXED); };

    describe("dateiso", () => {
        it("formats the local date", () => {
            freeze();
            expect(applyTransform("", "dateiso")).toBe("2026-07-29");
        });
        it("ignores the input text", () => {
            freeze();
            expect(applyTransform("hello world", "dateiso")).toBe("2026-07-29");
        });
        it("uses the local date, not UTC", () => {
            // 23:30 local on the 29th is already the 30th in UTC for negative offsets, and
            // still the 29th for positive ones — either way the local date must win.
            vi.useFakeTimers();
            vi.setSystemTime(new Date(2026, 6, 29, 23, 30, 0));
            expect(applyTransform("", "dateiso")).toBe("2026-07-29");
        });
        it("zero-pads single-digit months and days", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0));
            expect(applyTransform("", "dateiso")).toBe("2026-01-05");
        });
    });

    describe("datetimeiso", () => {
        it("formats local date and time", () => {
            freeze();
            expect(applyTransform("", "datetimeiso")).toBe("2026-07-29T09:52:44");
        });
        it("zero-pads the time components", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(2026, 0, 5, 7, 3, 9));
            expect(applyTransform("", "datetimeiso")).toBe("2026-01-05T07:03:09");
        });
    });

    describe("unixtime", () => {
        it("returns whole seconds since the epoch", () => {
            freeze();
            expect(applyTransform("", "unixtime")).toBe(String(Math.floor(FIXED.getTime() / 1000)));
        });
        it("has no decimal component", () => {
            freeze();
            expect(applyTransform("", "unixtime")).toMatch(/^\d+$/);
        });
        it("matches a known absolute epoch value", () => {
            // Hard-coded rather than derived from the fixture, so the assertion is independent
            // of the implementation's own arithmetic. Fixed to UTC to stay timezone-agnostic.
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.UTC(2026, 6, 29, 9, 52, 44)));
            expect(applyTransform("", "unixtime")).toBe("1785318764");
        });
    });

    describe("unixtimems", () => {
        it("matches a known absolute epoch value in milliseconds", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.UTC(2026, 6, 29, 9, 52, 44)));
            expect(applyTransform("", "unixtimems")).toBe("1785318764000");
        });
        it("preserves sub-second precision that unixtime discards", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.UTC(2026, 6, 29, 9, 52, 44, 137)));
            expect(applyTransform("", "unixtimems")).toBe("1785318764137");
            expect(applyTransform("", "unixtime")).toBe("1785318764");
        });
        it("is exactly 1000x the second-precision value at a whole second", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.UTC(2026, 6, 29, 9, 52, 44)));
            const ms = Number(applyTransform("", "unixtimems"));
            const s = Number(applyTransform("", "unixtime"));
            expect(ms).toBe(s * 1000);
        });
        it("ignores the input text", () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.UTC(2026, 6, 29, 9, 52, 44)));
            expect(applyTransform("hello world", "unixtimems")).toBe("1785318764000");
        });
    });
});

describe("isGenerator", () => {
    it("is true for transforms that ignore their input", () => {
        for (const t of ["uuid", "dateiso", "datetimeiso", "unixtime", "unixtimems"] as const) {
            expect(isGenerator(t)).toBe(true);
        }
    });
    it("is false for transforms that operate on the clipboard", () => {
        for (const t of ["upper", "lower", "trim", "base64encode", "count"] as const) {
            expect(isGenerator(t)).toBe(false);
        }
    });
});

describe("escapeForAppleScript", () => {
    it("leaves plain text untouched", () => expect(escapeForAppleScript("hello world")).toBe("hello world"));
    it("doubles backslashes", () => expect(escapeForAppleScript(String.raw`C:\path\to`)).toBe(String.raw`C:\\path\\to`));
    it("escapes double quotes", () => expect(escapeForAppleScript('say "hi"')).toBe(String.raw`say \"hi\"`));
    it("converts newlines to escape sequences", () => expect(escapeForAppleScript("a\nb")).toBe(String.raw`a\nb`));
    it("converts carriage returns to escape sequences", () => expect(escapeForAppleScript("a\r\nb")).toBe(String.raw`a\r\nb`));
    it("escapes backslashes before quotes so an escaped quote is not produced", () => {
        // Naive ordering would turn `\"` into `\\"`, ending the literal early
        expect(escapeForAppleScript(String.raw`a\"b`)).toBe(String.raw`a\\\"b`);
    });
    it("does not reinterpret a literal backslash-n as a newline", () => {
        expect(escapeForAppleScript(String.raw`literal \n here`)).toBe(String.raw`literal \\n here`);
    });
    it("handles escaped JSON", () => {
        expect(escapeForAppleScript(String.raw`{"k":"a\\b"}`)).toBe(String.raw`{\"k\":\"a\\\\b\"}`);
    });
    it("always produces a single-line result", () => {
        expect(escapeForAppleScript("one\ntwo\r\nthree")).not.toMatch(/[\r\n]/);
    });
});

describe("detectClipKind", () => {
    const kind = detectClipKind;

    it("parses real JSON objects and arrays", () => {
        expect(kind('{"a":1}')).toBe("json");
        expect(kind('[1,2,3]')).toBe("json");
        expect(kind('  { "nested": { "x": [1] } }  ')).toBe("json");
    });
    it("does not badge JSON-looking text that will not parse", () => {
        // Pattern-matching braces would call this JSON; parsing correctly refuses
        expect(kind('{ this is not json }')).toBe("text");
        expect(kind('{"unclosed": 1')).toBe("text");
    });
    it("does not badge bare scalars, which are technically valid JSON", () => {
        expect(kind("123")).toBe("text");
        expect(kind('"just a string"')).toBe("text");
        expect(kind("true")).toBe("text");
    });

    it("detects a whole-value URL", () => {
        expect(kind("https://example.com/a?b=c")).toBe("url");
        expect(kind("http://127.0.0.1:8080/x")).toBe("url");
    });
    it("treats prose mentioning a URL as text", () => {
        expect(kind("see https://example.com for details")).toBe("text");
    });

    it("detects a canonical UUID", () =>
        expect(kind("4e2562fd-b9b7-4977-9353-85da53cfdf91")).toBe("uuid"));
    it("accepts uppercase UUIDs", () =>
        expect(kind("4E2562FD-B9B7-4977-9353-85DA53CFDF91")).toBe("uuid"));
    it("accepts non-v4 UUIDs, which are still UUIDs", () =>
        expect(kind("00000000-0000-1000-8000-000000000000")).toBe("uuid"));
    it("rejects near-misses rather than mislabelling them", () => {
        expect(kind("4e2562fd-b9b7-4977-9353-85da53cfdf9")).toBe("text");   // too short
        expect(kind("4e2562fd-b9b7-4977-9353-85da53cfdf911")).toBe("text"); // too long
        expect(kind("4e2562fdb9b749779353 85da53cfdf91")).toBe("text");     // wrong shape
        expect(kind("zzzzzzzz-b9b7-4977-9353-85da53cfdf91")).toBe("text");  // not hex
    });
    it("treats a sentence containing a UUID as text", () =>
        expect(kind("id is 4e2562fd-b9b7-4977-9353-85da53cfdf91")).toBe("text"));

    it("detects a JWT by decoding its header", () => {
        const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig";
        expect(kind(jwt)).toBe("jwt");
    });
    it("rejects a dotted string that only looks like a JWT", () => {
        // Right shape, but the header does not decode to JSON with an alg
        expect(kind("aaa.bbb.ccc")).toBe("text");
        expect(kind("one.two.three.four")).toBe("text");
    });

    it("detects hex colours", () => {
        expect(kind("#fff")).toBe("color");
        expect(kind("#1e1e1e")).toBe("color");
        expect(kind("#FF8800CC")).toBe("color");
    });
    it("rejects malformed hex colours", () => {
        expect(kind("#12345")).toBe("text");
        expect(kind("#gggggg")).toBe("text");
    });

    it("detects IPv4 and IPv6", () => {
        expect(kind("192.168.1.10")).toBe("ip");
        expect(kind("127.0.0.1")).toBe("ip");
        expect(kind("2001:db8::1")).toBe("ip");
    });
    it("rejects out-of-range octets a regex would accept", () =>
        expect(kind("999.1.1.1")).toBe("text"));

    it("detects ISO dates and timestamps", () => {
        expect(kind("2026-07-29")).toBe("date");
        expect(kind("2026-07-29T09:52:44")).toBe("date");
        expect(kind("2026-07-29T09:52:44.616Z")).toBe("date");
    });
    it("rejects impossible calendar dates", () => {
        expect(kind("2026-13-45")).toBe("text");
        expect(kind("2026-02-30")).toBe("text");
        expect(kind("2026-07-29T25:99:00")).toBe("text");
    });
    it("treats a log line beginning with a timestamp as text", () =>
        expect(kind("2026-07-31T13:02:40.616Z WARN picker-host: frame 860x702")).toBe("text"));

    it("detects an email address", () => expect(kind("glen@example.com")).toBe("email"));
    it("treats a sentence containing an address as text", () =>
        expect(kind("mail glen@example.com today")).toBe("text"));

    it("detects unix and home paths", () => {
        expect(kind("/Users/glen/Documents/GitHub/quick-clips")).toBe("path");
        expect(kind("~/Library/Application Support")).toBe("path");
    });
    it("detects a Windows path", () => expect(kind("C:\\Users\\glen\\file.txt")).toBe("path"));
    it("treats a multi-line blob starting with a slash as text", () =>
        expect(kind("/one\n/two")).toBe("text"));

    it("falls back to text", () => {
        expect(kind("The quick brown fox")).toBe("text");
        expect(kind("")).toBe("text");
        expect(kind("   ")).toBe("text");
    });
});

describe("clip collections", () => {
    const mk = (value: string, id: string, at = 0): ClipEntry =>
        ({ id, label: summarizeClip(value), value, addedAt: at });

    describe("summarizeClip", () => {
        it("collapses whitespace onto one line", () =>
            expect(summarizeClip("a\n\n  b\tc")).toBe("a b c"));
        it("marks blank text rather than returning an empty label", () =>
            expect(summarizeClip("   \n ")).toBe("(blank)"));
        it("leaves text well past the old 72-char cap intact", () => {
            // The picker truncates with CSS, which adapts to the window; capping in JS first
            // just discarded text the row had room for.
            const s = summarizeClip("x".repeat(200));
            expect(s).toBe("x".repeat(200));
            expect(s.endsWith("…")).toBe(false);
        });
        it("still truncates pathologically long text", () => {
            const s = summarizeClip("x".repeat(5000));
            expect(s.endsWith("…")).toBe(true);
            expect(s.length).toBeLessThanOrEqual(401);
        });
        it("honours an explicit cap", () => {
            expect(summarizeClip("abcdefghij", 4)).toBe("abcd…");
        });
    });

    describe("addClip", () => {
        it("adds to the front", () => {
            const r = addClip([mk("old", "1")], "new", "2", 100);
            expect(r.added).toBe(true);
            expect(r.clips.map(c => c.value)).toEqual(["new", "old"]);
        });
        it("rejects whitespace-only text", () => {
            const r = addClip([], "  \n ", "1", 0);
            expect(r).toMatchObject({ added: false, reason: "empty" });
            expect(r.clips).toHaveLength(0);
        });
        it("rejects text over the cap rather than truncating it", () => {
            // Truncating would paste silently corrupt content later
            const r = addClip([], "x".repeat(MAX_CLIP_CHARS + 1), "1", 0);
            expect(r).toMatchObject({ added: false, reason: "too-long" });
        });
        it("accepts text exactly at the cap", () => {
            expect(addClip([], "x".repeat(MAX_CLIP_CHARS), "1", 0).added).toBe(true);
        });
        it("moves a duplicate to the front instead of adding a second copy", () => {
            const clips = [mk("a", "1"), mk("b", "2"), mk("c", "3")];
            const r = addClip(clips, "c", "new-id", 500);
            expect(r.clips.map(c => c.value)).toEqual(["c", "a", "b"]);
            expect(r.clips).toHaveLength(3);
        });
        it("preserves a user title when the same value is captured again", () => {
            // Re-copying something you already named must not silently discard the name
            const named = renameClip(addClip([], "abc", "id1", 1).clips, "id1", "P1 Client Id");
            const again = addClip(named, "abc", "id2", 2);
            expect(again.clips).toHaveLength(1);
            expect(again.clips[0].title).toBe("P1 Client Id");
        });
        it("allows two clips to share a title when their values differ", () => {
            let clips = addClip([], "value-one", "id1", 1).clips;
            clips = addClip(clips, "value-two", "id2", 2).clips;
            clips = renameClip(clips, "id1", "Client Id");
            clips = renameClip(clips, "id2", "Client Id");
            expect(clips).toHaveLength(2);
            expect(clips.map(c => c.title)).toEqual(["Client Id", "Client Id"]);
            // Distinct ids keep selection, rename and delete unambiguous despite the shared name
            expect(new Set(clips.map(c => c.id)).size).toBe(2);
        });
        it("removes only the intended clip when titles collide", () => {
            let clips = addClip([], "value-one", "id1", 1).clips;
            clips = addClip(clips, "value-two", "id2", 2).clips;
            clips = renameClip(clips, "id1", "Same");
            clips = renameClip(clips, "id2", "Same");
            const left = removeClip(clips, "id1");
            expect(left).toHaveLength(1);
            // The survivor is the *other* clip — deletion follows the id, not the shared title
            expect(left[0].id).toBe("id2");
            expect(left[0].value).toBe("value-two");
        });
        it("keeps the original id when de-duplicating", () => {
            const r = addClip([mk("a", "keep-me")], "a", "fresh-id", 1);
            expect(r.clips[0].id).toBe("keep-me");
        });
        it("preserves the exact value including whitespace", () => {
            const raw = "  indented\n\tline  ";
            expect(addClip([], raw, "1", 0).clips[0].value).toBe(raw);
        });
        it("enforces the collection cap, dropping the oldest", () => {
            let clips: ClipEntry[] = [];
            for (let i = 0; i < MAX_CLIPS + 10; i++) {
                clips = addClip(clips, `v${i}`, `id${i}`, i).clips;
            }
            expect(clips).toHaveLength(MAX_CLIPS);
            expect(clips[0].value).toBe(`v${MAX_CLIPS + 9}`);
            expect(clips.some(c => c.value === "v0")).toBe(false);
        });
        it("does not mutate the input array", () => {
            const clips = [mk("a", "1")];
            addClip(clips, "b", "2", 0);
            expect(clips).toHaveLength(1);
        });
    });

    describe("renameClip", () => {
        it("sets a user title", () => {
            const r = renameClip([mk("4e25-…", "1")], "1", "P1 Client Id");
            expect(r[0].title).toBe("P1 Client Id");
        });
        it("trims surrounding whitespace", () =>
            expect(renameClip([mk("v", "1")], "1", "  Padded  ")[0].title).toBe("Padded"));
        it("clears the title when blank, rather than storing an empty string", () => {
            const named = renameClip([mk("v", "1")], "1", "Name");
            const cleared = renameClip(named, "1", "   ");
            expect(cleared[0].title).toBeUndefined();
        });
        it("leaves other clips untouched", () => {
            const r = renameClip([mk("a", "1"), mk("b", "2")], "1", "First");
            expect(r[1].title).toBeUndefined();
        });
        it("ignores unknown ids", () =>
            expect(renameClip([mk("a", "1")], "nope", "X")[0].title).toBeUndefined());
        it("does not mutate the input", () => {
            const clips = [mk("a", "1")];
            renameClip(clips, "1", "Name");
            expect(clips[0].title).toBeUndefined();
        });
        it("never overwrites the value", () =>
            expect(renameClip([mk("secret-value", "1")], "1", "Label")[0].value).toBe("secret-value"));
    });

    describe("clipDisplayName", () => {
        it("prefers the user title", () =>
            expect(clipDisplayName({ ...mk("some long value", "1"), title: "My Name" })).toBe("My Name"));
        it("falls back to a summary of the value", () =>
            expect(clipDisplayName(mk("some long value", "1"))).toBe("some long value"));
        it("falls back when the title is only whitespace", () =>
            expect(clipDisplayName({ ...mk("the value", "1"), title: "   " })).toBe("the value"));
    });

    describe("splitUrl", () => {
        it("splits host from path", () =>
            expect(splitUrl("https://github.com/glmorgan/quick-clips"))
                .toEqual({ host: "github.com", rest: "/glmorgan/quick-clips" }));
        it("keeps the port, which distinguishes local services", () =>
            expect(splitUrl("http://localhost:8080/admin")?.host).toBe("localhost:8080"));
        it("keeps query and fragment", () =>
            expect(splitUrl("https://x.com/a?b=c#d")?.rest).toBe("/a?b=c#d"));
        it("treats a bare root path as no remainder", () =>
            expect(splitUrl("https://example.com/")).toEqual({ host: "example.com", rest: "" }));
        it("returns null for non-URLs", () => {
            expect(splitUrl("not a url")).toBeNull();
            expect(splitUrl("see https://example.com for details")).toBeNull();
            expect(splitUrl("/Users/glen/docs")).toBeNull();
        });
    });

    describe("clipRowText", () => {
        it("uses the host as the name for an unnamed URL", () => {
            const r = clipRowText(mk("https://github.com/glmorgan/quick-clips", "1"));
            expect(r).toEqual({ label: "github.com", detail: "/glmorgan/quick-clips" });
        });
        it("shows no detail for a bare host", () =>
            expect(clipRowText(mk("https://example.com", "1")))
                .toEqual({ label: "example.com", detail: undefined }));
        it("lets a user title override the derived host", () => {
            const clip = { ...mk("https://github.com/a", "1"), title: "Repo" };
            expect(clipRowText(clip).label).toBe("Repo");
            expect(clipRowText(clip).detail).toBe("https://github.com/a");
        });
        it("falls back to the value for non-URLs", () =>
            expect(clipRowText(mk("plain text here", "1")))
                .toEqual({ label: "plain text here", detail: undefined }));
    });

    describe("hiding", () => {
        const secret = () => ({ ...mk("sk_live_abcdef123456", "1"), title: "Stripe Key" });

        it("toggles on and off", () => {
            const on = toggleClipHidden([secret()], "1");
            expect(on[0].hidden).toBe(true);
            expect(toggleClipHidden(on, "1")[0].hidden).toBeUndefined();
        });
        it("does not mutate the input", () => {
            const clips = [secret()];
            toggleClipHidden(clips, "1");
            expect(clips[0].hidden).toBeUndefined();
        });
        it("never alters the value — masking is display only", () => {
            const on = toggleClipHidden([secret()], "1");
            expect(on[0].value).toBe("sk_live_abcdef123456");
        });

        it("masks the value in the row, keeping the name", () => {
            const row = clipRowText({ ...secret(), hidden: true });
            expect(row.label).toBe("Stripe Key");
            expect(row.detail).not.toContain("sk_live");
            expect(row.detail).toMatch(/^•+$/);
        });
        it("masks the label too when the clip has no name", () => {
            const row = clipRowText({ ...mk("sk_live_abcdef123456", "1"), hidden: true });
            expect(row.label).not.toContain("sk_live");
            expect(row.label).toMatch(/^•+$/);
        });
        it("uses a fixed-width mask, so the value length does not leak", () => {
            const short = clipRowText({ ...mk("abc", "1"), hidden: true }).label;
            const long = clipRowText({ ...mk("a".repeat(400), "2"), hidden: true }).label;
            expect(short).toBe(long);
        });

        it("excludes a hidden value from the search text", () => {
            const text = clipSearchText({ ...secret(), hidden: true });
            expect(text).toBe("Stripe Key");
            expect(text).not.toContain("sk_live");
        });
        it("includes the value when not hidden", () =>
            expect(clipSearchText(secret())).toContain("sk_live_abcdef123456"));
    });

    describe("removeClip", () => {
        it("removes by id", () =>
            expect(removeClip([mk("a", "1"), mk("b", "2")], "1").map(c => c.value)).toEqual(["b"]));
        it("ignores unknown ids", () =>
            expect(removeClip([mk("a", "1")], "nope")).toHaveLength(1));
    });

    describe("promoteClip", () => {
        it("moves the entry to the front", () =>
            expect(promoteClip([mk("a", "1"), mk("b", "2"), mk("c", "3")], "3").map(c => c.value))
                .toEqual(["c", "a", "b"]));
        it("returns the list unchanged for an unknown id", () =>
            expect(promoteClip([mk("a", "1")], "nope").map(c => c.value)).toEqual(["a"]));
    });
});

describe("isKeystrokeSafe", () => {
    it("accepts plain ASCII", () => expect(isKeystrokeSafe("hello world 123 !@#")).toBe(true));
    // Newlines vanish and tabs move focus under AppleScript, despite both being ASCII
    it("rejects newlines", () => expect(isKeystrokeSafe("a\nb")).toBe(false));
    it("rejects carriage returns", () => expect(isKeystrokeSafe("a\r\nb")).toBe(false));
    it("rejects tabs", () => expect(isKeystrokeSafe("a\tb")).toBe(false));
    it("rejects arrows", () => expect(isKeystrokeSafe("a → b")).toBe(false));
    it("rejects accented letters", () => expect(isKeystrokeSafe("café")).toBe(false));
    it("rejects em dashes", () => expect(isKeystrokeSafe("a—b")).toBe(false));
    it("rejects emoji", () => expect(isKeystrokeSafe("party 🎉")).toBe(false));
    it("rejects CJK", () => expect(isKeystrokeSafe("日本語")).toBe(false));
    it("accepts an empty string", () => expect(isKeystrokeSafe("")).toBe(true));
});

describe("generateLabel", () => {
    it("returns short text as-is", () => expect(generateLabel("hello")).toBe("hello"));
    it("fits exactly 7 chars on one line", () => expect(generateLabel("1234567")).toBe("1234567"));
    it("breaks at word boundary for 2-line fit", () => expect(generateLabel("Hello World")).toBe("Hello\nWorld"));
    it("breaks mid-word when no good boundary", () => expect(generateLabel("abcdefghijkl")).toBe("abcdefg\nhijkl"));
    it("truncates long text with ellipsis", () => {
        const result = generateLabel("This is a very long piece of text");
        expect(result).toContain("…");
        const lines = result.split("\n");
        expect(lines.length).toBe(2);
        expect(lines[0].length).toBeLessThanOrEqual(7);
    });
    it("collapses whitespace", () => expect(generateLabel("  hello   world  ")).toBe("hello\nworld"));
});
