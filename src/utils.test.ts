import { describe, it, expect } from "vitest";
import { applyTransform, generateLabel } from "./utils.js";

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
