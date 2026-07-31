import { describe, it, expect, vi, afterEach } from "vitest";
import {
    addClip, applyTransform, escapeForAppleScript, generateLabel, isGenerator,
    promoteClip, removeClip, summarizeClip, MAX_CLIPS, MAX_CLIP_CHARS, type ClipEntry,
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

describe("clip collections", () => {
    const mk = (value: string, id: string, at = 0): ClipEntry =>
        ({ id, label: summarizeClip(value), value, addedAt: at });

    describe("summarizeClip", () => {
        it("collapses whitespace onto one line", () =>
            expect(summarizeClip("a\n\n  b\tc")).toBe("a b c"));
        it("marks blank text rather than returning an empty label", () =>
            expect(summarizeClip("   \n ")).toBe("(blank)"));
        it("truncates long text with an ellipsis", () => {
            const s = summarizeClip("x".repeat(200));
            expect(s.endsWith("…")).toBe(true);
            expect(s.length).toBeLessThanOrEqual(73);
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
