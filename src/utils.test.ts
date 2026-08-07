import { describe, it, expect, vi, afterEach } from "vitest";
import {
    addClip, applyTransform, escapeForAppleScript, generateLabel, isGenerator,
    markClipUsed, moveClip, normaliseClips, removeClip, restoreClip, updateClip, classifySecret,
    applySecretVerdict,
    clipDisplayName,
    clipRowText, clipSearchText,
    toggleClipHidden, splitUrl,
    summarizeClip, detectClipKind,
    MAX_CLIPS, MAX_CLIP_CHARS, type ClipEntry,
} from "./utils.js";
import { isKeystrokeSafe, needsExactPaste, resolvePasteMode } from "./typing.js";

/** Title-only edit, for tests that only care about naming. */
const retitle = (clips: ClipEntry[], id: string, title: string): ClipEntry[] =>
    updateClip(clips, id, { title, value: clips.find(c => c.id === id)!.value }).clips;

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
        ({ id, value, addedAt: at });

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
            const named = retitle(addClip([], "abc", "id1", 1).clips, "id1", "P1 Client Id");
            const again = addClip(named, "abc", "id2", 2);
            expect(again.clips).toHaveLength(1);
            expect(again.clips[0].title).toBe("P1 Client Id");
        });
        it("allows two clips to share a title when their values differ", () => {
            let clips = addClip([], "value-one", "id1", 1).clips;
            clips = addClip(clips, "value-two", "id2", 2).clips;
            clips = retitle(clips, "id1", "Client Id");
            clips = retitle(clips, "id2", "Client Id");
            expect(clips).toHaveLength(2);
            expect(clips.map(c => c.title)).toEqual(["Client Id", "Client Id"]);
            // Distinct ids keep selection, rename and delete unambiguous despite the shared name
            expect(new Set(clips.map(c => c.id)).size).toBe(2);
        });
        it("removes only the intended clip when titles collide", () => {
            let clips = addClip([], "value-one", "id1", 1).clips;
            clips = addClip(clips, "value-two", "id2", 2).clips;
            clips = retitle(clips, "id1", "Same");
            clips = retitle(clips, "id2", "Same");
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

    describe("updateClip", () => {
        it("sets a user title", () => {
            const r = updateClip([mk("4e25-…", "1")], "1", { title: "P1 Client Id", value: "4e25-…" });
            expect(r.updated).toBe(true);
            expect(r.clips[0].title).toBe("P1 Client Id");
        });
        it("trims surrounding whitespace from the title", () =>
            expect(updateClip([mk("v", "1")], "1", { title: "  Padded  ", value: "v" }).clips[0].title)
                .toBe("Padded"));
        it("clears the title when blank, rather than storing an empty string", () => {
            const named = updateClip([mk("v", "1")], "1", { title: "Name", value: "v" }).clips;
            const cleared = updateClip(named, "1", { title: "   ", value: "v" }).clips;
            expect(cleared[0].title).toBeUndefined();
        });
        it("leaves other clips untouched", () => {
            const r = updateClip([mk("a", "1"), mk("b", "2")], "1", { title: "First", value: "a" });
            expect(r.clips[1]).toEqual(mk("b", "2"));
        });
        it("does not mutate the input", () => {
            const clips = [mk("a", "1")];
            updateClip(clips, "1", { title: "Name", value: "changed" });
            expect(clips[0]).toEqual(mk("a", "1"));
        });

        it("replaces the text", () => {
            const r = updateClip([mk("before", "1")], "1", { title: "", value: "after" });
            expect(r.clips[0].value).toBe("after");
        });
        it("makes the row show the new text, with no trace of the old", () => {
            const r = updateClip([mk("before", "1")], "1", { title: "", value: "after" });
            const row = clipRowText(r.clips[0]);
            expect(row.label).toBe("after");
            expect(JSON.stringify(r.clips[0])).not.toContain("before");
        });
        it("keeps id, capture time and masking across an edit", () => {
            const secret: ClipEntry = { ...mk("old", "s1"), hidden: true, addedAt: 42 };
            const r = updateClip([secret], "s1", { title: "Key", value: "new" });
            expect(r.clips[0].id).toBe("s1");
            expect(r.clips[0].addedAt).toBe(42);
            expect(r.clips[0].hidden).toBe(true);
        });
        it("does not reorder the collection", () => {
            const clips = [mk("a", "1"), mk("b", "2"), mk("c", "3")];
            const r = updateClip(clips, "3", { title: "", value: "edited" });
            expect(r.clips.map(c => c.id)).toEqual(["1", "2", "3"]);
        });
        it("preserves whitespace exactly", () => {
            const raw = "  indented\n\tline  ";
            expect(updateClip([mk("x", "1")], "1", { title: "", value: raw }).clips[0].value).toBe(raw);
        });

        it("refuses an unknown id", () => {
            const r = updateClip([mk("a", "1")], "nope", { title: "X", value: "y" });
            expect(r.updated).toBe(false);
            expect(r.reason).toBe("missing");
        });
        it("refuses empty text", () => {
            const r = updateClip([mk("a", "1")], "1", { title: "Name", value: "   \n " });
            expect(r.updated).toBe(false);
            expect(r.reason).toBe("empty");
            expect(r.clips[0].value).toBe("a");
        });
        it("refuses text past the cap", () => {
            const r = updateClip([mk("a", "1")], "1", { title: "", value: "x".repeat(MAX_CLIP_CHARS + 1) });
            expect(r.updated).toBe(false);
            expect(r.reason).toBe("too-long");
        });
        it("refuses text another clip already holds, which addClip otherwise prevents", () => {
            const r = updateClip([mk("a", "1"), mk("b", "2")], "1", { title: "", value: "b" });
            expect(r.updated).toBe(false);
            expect(r.reason).toBe("duplicate");
            expect(r.clips.map(c => c.value)).toEqual(["a", "b"]);
        });
        it("allows an edit that leaves the text alone, so a title-only change works", () => {
            const r = updateClip([mk("a", "1"), mk("b", "2")], "1", { title: "Named", value: "a" });
            expect(r.updated).toBe(true);
            expect(r.clips[0].title).toBe("Named");
        });
        it("allows two clips to share a title when their values differ", () => {
            let clips = [mk("one", "1"), mk("two", "2")];
            clips = updateClip(clips, "1", { title: "Same", value: "one" }).clips;
            clips = updateClip(clips, "2", { title: "Same", value: "two" }).clips;
            expect(clips.map(c => c.title)).toEqual(["Same", "Same"]);
        });
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
        const secret = () => ({ ...mk("sk_live_" + "EXAMPLE".repeat(3), "1"), title: "Stripe Key" });

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
            expect(on[0].value).toBe("sk_live_" + "EXAMPLE".repeat(3));
        });

        it("masks the value in the row, keeping the name", () => {
            const row = clipRowText({ ...secret(), hidden: true });
            expect(row.label).toBe("Stripe Key");
            expect(row.detail).not.toContain("sk_live");
            expect(row.detail).toMatch(/^•+$/);
        });
        it("masks the label too when the clip has no name", () => {
            const row = clipRowText({ ...mk("sk_live_" + "EXAMPLE".repeat(3), "1"), hidden: true });
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
            expect(clipSearchText(secret())).toContain("sk_live_" + "EXAMPLE".repeat(3)));
    });

    describe("removeClip", () => {
        it("removes by id", () =>
            expect(removeClip([mk("a", "1"), mk("b", "2")], "1").map(c => c.value)).toEqual(["b"]));
        it("ignores unknown ids", () =>
            expect(removeClip([mk("a", "1")], "nope")).toHaveLength(1));
    });

    describe("restoreClip", () => {
        const three = () => [mk("a", "1"), mk("b", "2"), mk("c", "3")];

        it("puts the clip back at the index it was deleted from", () => {
            const clips = three();
            const gone = clips[1];
            const after = removeClip(clips, "2");
            const r = restoreClip(after, gone, 1);
            expect(r.restored).toBe(true);
            expect(r.clips.map(c => c.value)).toEqual(["a", "b", "c"]);
        });
        it("restores the entry unchanged, including its title and hidden flag", () => {
            const secret: ClipEntry = { ...mk("sk_live_x", "s1"), title: "Stripe", hidden: true };
            const r = restoreClip([], secret, 0);
            expect(r.clips[0]).toEqual(secret);
        });
        it("clamps an index past the end of a list that shrank meanwhile", () => {
            const gone = mk("z", "9");
            const r = restoreClip([mk("a", "1")], gone, 7);
            expect(r.clips.map(c => c.value)).toEqual(["a", "z"]);
        });
        it("still lands at the front when the deleted clip was first", () => {
            const clips = three();
            const r = restoreClip(removeClip(clips, "1"), clips[0], 0);
            expect(r.clips.map(c => c.value)).toEqual(["a", "b", "c"]);
        });
        it("does not mutate the list it was given", () => {
            const after = [mk("a", "1")];
            restoreClip(after, mk("b", "2"), 0);
            expect(after).toHaveLength(1);
        });
        it("refuses a second undo of the same clip", () => {
            const clips = three();
            const restored = restoreClip(removeClip(clips, "2"), clips[1], 1);
            const again = restoreClip(restored.clips, clips[1], 1);
            expect(again.restored).toBe(false);
            expect(again.reason).toBe("duplicate");
            expect(again.clips).toHaveLength(3);
        });
        it("refuses when the same text was captured again under a new id", () => {
            const gone = mk("shared-text", "old");
            const readded = addClip([], "shared-text", "new", 1).clips;
            const r = restoreClip(readded, gone, 0);
            expect(r.restored).toBe(false);
            expect(r.reason).toBe("duplicate");
        });
        it("refuses rather than pushing out the oldest clip when full", () => {
            let clips: ClipEntry[] = [];
            for (let i = 0; i < MAX_CLIPS; i++) clips = addClip(clips, `v${i}`, `id${i}`, i).clips;
            const r = restoreClip(clips, mk("restored", "extra"), 0);
            expect(r.restored).toBe(false);
            expect(r.reason).toBe("full");
            // The clip that would have been evicted is still there
            expect(r.clips).toHaveLength(MAX_CLIPS);
            expect(r.clips.some(c => c.value === "v0")).toBe(true);
        });
    });

    describe("markClipUsed", () => {
        it("records the time without moving the clip", () => {
            const clips = [mk("a", "1"), mk("b", "2"), mk("c", "3")];
            const after = markClipUsed(clips, "3", 999);
            expect(after.map(c => c.id)).toEqual(["1", "2", "3"]);
            expect(after[2].lastUsedAt).toBe(999);
        });
        it("leaves the other clips untouched", () => {
            const after = markClipUsed([mk("a", "1"), mk("b", "2")], "1", 5);
            expect(after[1].lastUsedAt).toBeUndefined();
        });
        it("ignores unknown ids", () =>
            expect(markClipUsed([mk("a", "1")], "nope", 5)[0].lastUsedAt).toBeUndefined());
        it("does not mutate the input", () => {
            const clips = [mk("a", "1")];
            markClipUsed(clips, "1", 5);
            expect(clips[0].lastUsedAt).toBeUndefined();
        });
    });

    describe("moveClip", () => {
        const three = () => [mk("a", "1"), mk("b", "2"), mk("c", "3")];
        const ids = (cs: ClipEntry[]) => cs.map(c => c.id).join(",");

        it("moves a clip down one place", () =>
            expect(ids(moveClip(three(), "1", 1))).toBe("2,1,3"));
        it("moves a clip up one place", () =>
            expect(ids(moveClip(three(), "3", -1))).toBe("1,3,2"));
        it("moves several places at once", () =>
            expect(ids(moveClip(three(), "1", 2))).toBe("2,3,1"));

        // Clamped, not wrapped: holding the key at the end should stop, not jump to the far end
        it("stops at the top", () => expect(ids(moveClip(three(), "1", -1))).toBe("1,2,3"));
        it("stops at the bottom", () => expect(ids(moveClip(three(), "3", 1))).toBe("1,2,3"));
        it("clamps an overshoot rather than wrapping", () =>
            expect(ids(moveClip(three(), "2", 99))).toBe("1,3,2"));

        it("ignores an unknown id", () =>
            expect(ids(moveClip(three(), "nope", 1))).toBe("1,2,3"));
        it("does not mutate the input", () => {
            const clips = three();
            moveClip(clips, "1", 1);
            expect(ids(clips)).toBe("1,2,3");
        });
        it("carries the clip intact, masking and all", () => {
            const secret: ClipEntry = { ...mk("v", "1"), hidden: true, title: "Key", lastUsedAt: 7 };
            const after = moveClip([secret, mk("b", "2")], "1", 1);
            expect(after[1]).toEqual(secret);
        });
        it("is a no-op for a single clip", () =>
            expect(ids(moveClip([mk("a", "1")], "1", 1))).toBe("1"));
    });

    describe("markClipUsed and re-capture", () => {
        it("keeps the usage time when the same text is captured again", () => {
            // The dedupe path rebuilds the entry, which is where the field could quietly be lost
            const used = markClipUsed(addClip([], "shared", "id1", 1).clips, "id1", 5_000);
            const again = addClip(used, "shared", "id2", 9_000);
            expect(again.clips).toHaveLength(1);
            expect(again.clips[0].id).toBe("id1");
            expect(again.clips[0].lastUsedAt).toBe(5_000);
        });
    });

    describe("eviction at the cap", () => {
        /** A full collection, oldest-added last, where the oldest-added is also the most used. */
        const full = (): ClipEntry[] => {
            let clips: ClipEntry[] = [];
            for (let i = 0; i < MAX_CLIPS; i++) clips = addClip(clips, `v${i}`, `id${i}`, i).clips;
            return clips;
        };
        it("drops the least recently used, not merely the oldest", () => {
            // id0 was added first but is used constantly; id1 was added next and never touched.
            const clips = markClipUsed(full(), "id0", 10_000);
            const after = addClip(clips, "fresh", "new", 99_999).clips;
            expect(after).toHaveLength(MAX_CLIPS);
            expect(after.some(c => c.id === "id0")).toBe(true);
            expect(after.some(c => c.id === "id1")).toBe(false);
        });
        it("falls back to capture time for clips never pasted", () => {
            const after = addClip(full(), "fresh", "new", 99_999).clips;
            // Nothing has a lastUsedAt, so the earliest captured goes
            expect(after.some(c => c.id === "id0")).toBe(false);
            expect(after.some(c => c.id === "id1")).toBe(true);
        });
        it("never evicts the clip just captured", () => {
            const after = addClip(full(), "fresh", "new", 0).clips;
            expect(after[0].value).toBe("fresh");
        });
        it("keeps every surviving clip in its existing position", () => {
            const before = markClipUsed(full(), "id0", 10_000);
            const after = addClip(before, "fresh", "new", 99_999).clips;
            const survivors = before.filter(c => c.id !== "id1").map(c => c.id);
            expect(after.slice(1).map(c => c.id)).toEqual(survivors);
        });
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

describe("paste mode", () => {
    describe("needsExactPaste", () => {
        it("is false for ordinary one-line text", () =>
            expect(needsExactPaste("postgres://user:pw@localhost:5432/appdb")).toBe(false));
        it("is false for single-line JSON", () =>
            expect(needsExactPaste('{"a":1,"b":[2,3]}')).toBe(false));
        it("is false for text with unicode, which types fine", () =>
            expect(needsExactPaste("café 🎉 日本語")).toBe(false));
        // Return and Tab are keys before they are characters
        it("is true for a newline", () => expect(needsExactPaste("line one\nline two")).toBe(true));
        it("is true for a carriage return", () => expect(needsExactPaste("a\r\nb")).toBe(true));
        it("is true for a tab", () => expect(needsExactPaste("key\tvalue")).toBe(true));
        it("is true for pretty-printed JSON", () =>
            expect(needsExactPaste('{\n  "a": 1\n}')).toBe(true));
        it("is false for empty text", () => expect(needsExactPaste("")).toBe(false));
    });

    describe("resolvePasteMode", () => {
        it("types one-line text when unset", () =>
            expect(resolvePasteMode(undefined, "hello")).toBe("typing"));
        it("pastes multi-line text when unset", () =>
            expect(resolvePasteMode(undefined, "a\nb")).toBe("clipboard"));
        it("treats auto the same as unset", () => {
            expect(resolvePasteMode("auto", "hello")).toBe("typing");
            expect(resolvePasteMode("auto", "a\nb")).toBe("clipboard");
        });
        // An explicit choice is never second-guessed, in either direction
        it("honours an explicit typing choice for multi-line text", () =>
            expect(resolvePasteMode("typing", "a\nb")).toBe("typing"));
        it("honours an explicit clipboard choice for one-line text", () =>
            expect(resolvePasteMode("clipboard", "hello")).toBe("clipboard"));
    });
});

describe("classifySecret", () => {
    const verdict = (v: string) => classifySecret(v);

    describe("identifies published token formats", () => {
        const identified: [string, string][] = [
            ["GitHub PAT", "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"],
            ["GitHub fine-grained", "github_pat_11ABCDEFG0abcdefghijkl_" + "A".repeat(30)],
            ["GitLab PAT", "glpat-" + "EXAMPLE".repeat(3)],
            ["Stripe secret key", "sk_live_" + "EXAMPLE".repeat(3)],
            ["Stripe restricted key", "rk_live_" + "EXAMPLE".repeat(3)],
            ["Slack bot token", "xoxb-" + "123456789012-1234567890123-" + "EXAMPLE".repeat(3)],
            ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
            ["Google API key", "AIza" + "EXAMPLE".repeat(5)],   // AIza + exactly 35
            ["Anthropic key", "sk-ant-" + "EXAMPLE".repeat(4)],
            ["npm token", "npm_" + "a".repeat(36)],
            ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"],
        ];
        for (const [name, value] of identified) {
            it(`flags ${name} as identified`, () => {
                const r = verdict(value);
                expect(r.secret).toBe(true);
                expect(r.confidence).toBe("identified");
            });
        }
        it("flags a JWT", () => {
            const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
            const body = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
            expect(verdict(`${header}.${body}.c2ln`).confidence).toBe("identified");
        });
        it("flags a connection string carrying a password", () => {
            const r = verdict("postgres://user:s3cr3t@localhost:5432/appdb");
            expect(r.secret).toBe(true);
            expect(r.confidence).toBe("identified");
        });
        it("does not flag the same URL without a password", () =>
            expect(verdict("postgres://user@localhost:5432/appdb").secret).toBe(false));
    });

    describe("recognises a credential by its context, not just its shape", () => {
        // A token copied from devtools or curl arrives wrapped in its header. The space in it
        // defeats the shape heuristic, so without these, adding the context that proves it is a
        // credential made it *less* likely to be masked.
        const contextual: [string, string, string][] = [
            ["an Authorization header", "Authorization: Bearer kJ8xQ2mN4vBtYwR7pL5zA0sD3fG6hJ9", "Authorization header"],
            ["a bare Bearer token", "Bearer kJ8xQ2mN4vBtYwR7pL5zA0sD3fG6hJ9kM1nP4qR7tV0wX2yZ", "Bearer token"],
            ["a Proxy-Authorization header", "Proxy-Authorization: Basic dXNlcjpwdw==", "Authorization header"],
            ["a curl command carrying one", "curl -H 'Authorization: Bearer abc123def456' https://api.example.com", "Authorization header"],
        ];
        for (const [name, value, title] of contextual) {
            it(`identifies ${name}`, () => {
                const r = classifySecret(value);
                expect(r.secret).toBe(true);
                expect(r.confidence).toBe("identified");
                expect(r.title).toBe(title);
            });
        }

        it("identifies an assignment and names it after the field", () => {
            const r = classifySecret("x-api-key: kJ8xQ2mN4vBtYwR7pL5zA0sD");
            expect(r.confidence).toBe("identified");
            expect(r.title).toBe("x-api-key");
        });
        it("treats an underscore as a separator, so DATABASE_PASSWORD is identified", () => {
            const r = classifySecret("DATABASE_PASSWORD=s3cr3t-hunter2-value");
            expect(r.confidence).toBe("identified");
            expect(r.title).toBe("PASSWORD");
        });
        it("names the field, never the value", () => {
            const r = classifySecret('{"api_key": "abcdefghijklmnopqrst"}');
            expect(r.title).toBe("api_key");
            expect(r.reason).not.toContain("abcdefghij");
        });

        // The value has to look like one: a name alone is not enough, or prose would trip it
        it("ignores prose that merely mentions a password", () =>
            expect(classifySecret("password: 8 characters minimum, one symbol").secret).toBe(false));
        it("ignores a sentence after a colon", () =>
            expect(classifySecret("token: the meeting is at 3pm tomorrow").secret).toBe(false));
        it("ignores a short non-credential assignment", () =>
            expect(classifySecret("reset_password=true").secret).toBe(false));

        // An allow rule that clears a real credential is worse than a plain miss
        it("does not let the base64 allow clear a Basic credential", () => {
            const basic = Buffer.from("user:hunter2-password").toString("base64");
            const r = classifySecret(basic);
            expect(r.secret).toBe(true);
            expect(r.confidence).toBe("identified");
            expect(r.title).toBe("Basic credential");
        });
        it("still allows base64 of ordinary text", () => {
            const b64 = Buffer.from("this is just some ordinary configuration text").toString("base64");
            expect(classifySecret(b64).secret).toBe(false);
        });
    });

    describe("never masks things that only look random", () => {
        // Hex caps at 4 bits per character, which is why none of these reach the threshold
        const allowed: [string, string][] = [
            ["a UUID", "f47ac10b-58cc-4372-a567-0e02b2c3d479"],
            ["a git SHA", "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"],
            ["a SHA-256 hash", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
            ["an MD5 hash", "5d41402abc4b2a76b9719d911017c592"],
            ["a long file path", "/Users/glen/Documents/GitHub/quick-clips/src/actions/clipboard-manager.ts"],
            ["a plain URL", "https://dashboard.stripe.com/test/payments?status=succeeded"],
            ["prose", "The quick brown fox jumps over the lazy dog again and again"],
            ["a Stripe object id", "ch_3OxKzLkdIwHu7ix1aQ9vXbCd"],
        ];
        for (const [name, value] of allowed) {
            it(`leaves ${name} alone`, () => expect(verdict(value).secret).toBe(false));
        }
        // Masking this would be actively wrong: it is meant to be published
        it("never masks a Stripe publishable key, despite its entropy", () => {
            const r = verdict("pk_live_" + "EXAMPLE".repeat(3));
            expect(r.secret).toBe(false);
            expect(r.reason).toContain("publishable");
        });
        it("leaves base64 of readable text alone", () => {
            const b64 = Buffer.from("this is just some ordinary configuration text").toString("base64");
            expect(verdict(b64).secret).toBe(false);
        });
    });

    describe("the shape heuristic, and what it admits it cannot do", () => {
        it("flags a long opaque token, but only as a heuristic", () => {
            const r = verdict("kJ8xQ2mN_4vB-tYwR7pL5zA0sD3fG6hJ9kM1nP4qR7tV0wX2yZ5aC8eF1gH3iK6l");
            expect(r.secret).toBe(true);
            expect(r.confidence).toBe("heuristic");
        });
        it("still flags base64 that decodes to random bytes", () => {
            const b64 = Buffer.from(Uint8Array.from({ length: 48 }, (_, i) => (i * 97 + 13) % 256))
                .toString("base64");
            expect(verdict(b64).secret).toBe(true);
        });
        // The known gap, recorded so nobody mistakes a pass for a clean bill of health
        it("misses a short password, which nothing here can catch", () =>
            expect(verdict("hunter2!").secret).toBe(false));
        it("misses an internal token below the length floor", () =>
            expect(verdict("aB3xQ9zK").secret).toBe(false));
        it("treats an empty value as nothing", () =>
            expect(verdict("   ").confidence).toBe("none"));
    });
});

describe("applySecretVerdict", () => {
    // Local copy: the shared one lives inside the clip-collections block.
    const mk = (value: string, id: string): ClipEntry => ({ id, value, addedAt: 1 });
    const clips = (): ClipEntry[] => [mk("ghp_token", "1"), mk("other", "2")];

    it("masks the clip and names it", () => {
        const v = classifySecret("ghp_" + "A".repeat(36));
        const after = applySecretVerdict(clips(), "1", v);
        expect(after[0].hidden).toBe(true);
        expect(after[0].title).toBe("GitHub token");
    });
    it("leaves everything alone when the verdict is not a secret", () => {
        const after = applySecretVerdict(clips(), "1", classifySecret("just some text"));
        expect(after[0].hidden).toBeUndefined();
        expect(after[0].title).toBeUndefined();
    });
    it("never overwrites a name the user gave", () => {
        const named: ClipEntry[] = [{ ...mk("v", "1"), title: "Prod deploy key" }];
        const after = applySecretVerdict(named, "1", classifySecret("ghp_" + "A".repeat(36)));
        expect(after[0].title).toBe("Prod deploy key");
        expect(after[0].hidden).toBe(true);
    });
    it("touches no other clip", () => {
        const after = applySecretVerdict(clips(), "1", classifySecret("ghp_" + "A".repeat(36)));
        expect(after[1]).toEqual(mk("other", "2"));
    });
    it("does not mutate the input", () => {
        const original = clips();
        applySecretVerdict(original, "1", classifySecret("ghp_" + "A".repeat(36)));
        expect(original[0].hidden).toBeUndefined();
    });

    // The point of the generated name: a masked clip keeps a way to be found and told apart
    it("leaves the masked clip findable by its generated name", () => {
        const after = applySecretVerdict(clips(), "1", classifySecret("ghp_" + "A".repeat(36)));
        expect(clipSearchText(after[0])).toBe("GitHub token");
        expect(clipSearchText(after[0])).not.toContain("ghp_");
    });
    it("shows the name beside the mask instead of bare dots", () => {
        const after = applySecretVerdict(clips(), "1", classifySecret("ghp_" + "A".repeat(36)));
        const row = clipRowText(after[0]);
        expect(row.label).toBe("GitHub token");
        expect(row.detail).toMatch(/^•+$/);
    });

    it("names the heuristic case generically", () => {
        const opaque = "kJ8xQ2mN_4vB-tYwR7pL5zA0sD3fG6hJ9kM1nP4qR7tV0wX2yZ5aC8eF1gH3iK6l";
        const after = applySecretVerdict([mk(opaque, "1")], "1", classifySecret(opaque));
        expect(after[0].title).toBe("Opaque token");
    });
    it("names a URL carrying a password", () => {
        const url = "postgres://user:s3cr3t@localhost:5432/appdb";
        const after = applySecretVerdict([mk(url, "1")], "1", classifySecret(url));
        expect(after[0].title).toBe("URL with password");
    });
    // The generated names must never carry any of the value itself
    it("never puts the value in the generated name", () => {
        for (const v of ["ghp_" + "SEKRIT".repeat(6), "postgres://u:hunter2@h/d",
                         "kJ8xQ2mN_4vB-tYwR7pL5zA0sD3fG6hJ9kM1nP4qR7tV0wX2yZ5aC8eF1gH3iK6l"]) {
            const t = classifySecret(v).title ?? "";
            expect(v.includes(t)).toBe(false);
            expect(t.length).toBeLessThan(30);
        }
    });
});

describe("normaliseClips", () => {
    const legacy = (value: string, id: string) =>
        ({ id, value, addedAt: 1, label: value } as unknown as ClipEntry);

    it("drops a stored label", () => {
        const r = normaliseClips([legacy("secret-value", "1")]);
        expect(r.changed).toBe(true);
        expect("label" in r.clips[0]).toBe(false);
    });
    it("keeps everything else intact", () => {
        const clip = { ...legacy("v", "1"), title: "Named", hidden: true, lastUsedAt: 9 };
        const r = normaliseClips([clip as ClipEntry]);
        expect(r.clips[0]).toEqual({ id: "1", value: "v", addedAt: 1, title: "Named", hidden: true, lastUsedAt: 9 });
    });
    it("reports no change for a collection already clean", () => {
        const r = normaliseClips([{ id: "1", value: "v", addedAt: 1 }]);
        expect(r.changed).toBe(false);
    });
    it("leaves a field it does not know about alone, so a newer version survives an older one", () => {
        const future = { id: "1", value: "v", addedAt: 1, somethingNew: true } as unknown as ClipEntry;
        const r = normaliseClips([future]);
        expect((r.clips[0] as any).somethingNew).toBe(true);
        expect(r.changed).toBe(false);
    });
    // The reason for the removal: a masked clip was writing its secret into the profile twice
    it("stops a masked clip storing its value twice", () => {
        const clip = { ...legacy("ghp_secret_token_value", "1"), hidden: true, title: "GitHub token" };
        const before = JSON.stringify(clip);
        const after = JSON.stringify(normaliseClips([clip as ClipEntry]).clips[0]);
        expect(before.split("ghp_secret_token_value").length - 1).toBe(2);
        expect(after.split("ghp_secret_token_value").length - 1).toBe(1);
        expect(after.length).toBeLessThan(before.length);
    });
});
