import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";
import { InvalidExpressionError } from "./QueryError.ts";

describe("parseBodyMatcher", () => {
    it("dispatches xpath via // prefix", () => {
        const p = parseBodyMatcher("//user[@role='admin']");
        assert.equal(p.dialect, "xpath");
        assert.equal(p.pattern, "//user[@role='admin']");
        assert.equal(p.flags, undefined);
    });

    it("dispatches jsonpath via $ prefix", () => {
        const p = parseBodyMatcher("$.users[*].name");
        assert.equal(p.dialect, "jsonpath");
        assert.equal(p.pattern, "$.users[*].name");
    });

    it("dispatches regex via /pattern/ form with flags", () => {
        const p = parseBodyMatcher("/error.*/gi");
        assert.equal(p.dialect, "regex");
        assert.equal(p.pattern, "error.*");
        assert.equal(p.flags, "gi");
    });

    it("dispatches regex via /pattern/ form without flags", () => {
        const p = parseBodyMatcher("/error.*/");
        assert.equal(p.dialect, "regex");
        assert.equal(p.pattern, "error.*");
        assert.equal(p.flags, undefined);
    });

    it("rejects a regex without its closing slash", () => {
        assert.throws(() => parseBodyMatcher("/error.*"), InvalidExpressionError);
    });

    it("supports all flag characters per JS regex spec (gimsuy)", () => {
        const p = parseBodyMatcher("/foo/gimsuy");
        assert.equal(p.dialect, "regex");
        assert.equal(p.flags, "gimsuy");
    });

    it("keeps escaped slashes and slashes inside character classes in the pattern", () => {
        assert.deepEqual(parseBodyMatcher("/a\\/b/i"), {
            dialect: "regex",
            pattern: "a\\/b",
            flags: "i",
        });
        assert.deepEqual(parseBodyMatcher("/[/]/"), {
            dialect: "regex",
            pattern: "[/]",
            flags: undefined,
        });
    });

    it("rejects invalid patterns and flags at the classifier boundary", () => {
        assert.throws(() => parseBodyMatcher("/[abc/"), InvalidExpressionError);
        assert.throws(() => parseBodyMatcher("/foo/nope"), InvalidExpressionError);
    });

    it("dispatches glob for anything not matching the other prefixes", () => {
        const p = parseBodyMatcher("*.log");
        assert.equal(p.dialect, "glob");
        assert.equal(p.pattern, "*.log");
    });

    it("treats // as xpath even when followed by something xpath-looking-but-isn't", () => {
        const p = parseBodyMatcher("//foo");
        assert.equal(p.dialect, "xpath");
    });

    it("treats single $ as jsonpath (handles edge of single-char roots)", () => {
        const p = parseBodyMatcher("$");
        assert.equal(p.dialect, "jsonpath");
    });
});
