import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./deps-preflight.mjs";

// A single outdated package, npm's object shape (one workspace).
const OUT = { linkedom: { current: "0.18.13", latest: "1.0.0" } };
const WAIVER = { reason: "1.0 drops required loose-fragment parsing", issue: "https://example.test/issues/500", lane: "mimetypes" };

describe("deps-preflight classify — fail on any update", () => {
    it("passes a fresh tree (nothing outdated)", () => {
        const { blockers, excused } = classify({}, {}, [], new Set());
        assert.deepEqual(blockers, []);
        assert.deepEqual(excused, []);
    });

    it("blocks an outdated package with no waiver", () => {
        const { blockers, excused } = classify(OUT, {}, [], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].name, "linkedom");
        assert.equal(blockers[0].latest, "1.0.0");
    });

    it("excuses an outdated package with a complete waiver", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, [], new Set());
        assert.equal(blockers.length, 0);
        assert.equal(excused.length, 1);
        assert.equal(excused[0].name, "linkedom");
    });

    it("blocks an incomplete waiver (missing issue)", () => {
        const { blockers, excused } = classify(OUT, { linkedom: { reason: "later", lane: "mimetypes" } }, [], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
    });

    it("ownerVeto outranks a complete waiver — blocks and flags it vetoed", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, ["linkedom"], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].vetoed, true);
    });

    it("handles npm's array shape (one dep outdated across several workspaces)", () => {
        const arr = { turndown: [{ current: "7.2.0", latest: "7.2.4" }, { current: "7.2.0", latest: "7.2.4" }] };
        const { blockers } = classify(arr, {}, [], new Set());
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].latest, "7.2.4");
    });

    it("skips workspace platform packages but blocks @plurnk-scoped externals (#349)", () => {
        const out = {
            "@plurnk/plurnk-contracts": { current: "1.9.0", latest: "1.9.1" },
            "@plurnk/plurnk-mimetypes-grammar-fsharp": { current: "1.3.1", latest: "1.4.0" },
        };
        const { blockers, excused } = classify(out, {}, [], new Set(["@plurnk/plurnk-contracts"]));
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].name, "@plurnk/plurnk-mimetypes-grammar-fsharp");
    });
});
