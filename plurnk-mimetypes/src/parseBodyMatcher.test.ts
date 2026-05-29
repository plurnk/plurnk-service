import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";

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

    it("dispatches regex without trailing slash leniently (takes the whole tail)", () => {
        const p = parseBodyMatcher("/error.*");
        assert.equal(p.dialect, "regex");
        assert.equal(p.pattern, "error.*");
    });

    it("supports all flag characters per JS regex spec (gimsuy)", () => {
        const p = parseBodyMatcher("/foo/gimsuy");
        assert.equal(p.dialect, "regex");
        assert.equal(p.flags, "gimsuy");
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
