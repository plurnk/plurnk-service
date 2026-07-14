import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./deps-preflight.mjs";

// A single outdated package, npm's object shape (one workspace).
const OUT = { linkedom: { current: "0.18.13", latest: "1.0.0" } };
const WAIVER = { reason: "1.0 drops the loose-fragment parsing #412 relies on", issue: "#500", lane: "mimetypes" };

describe("deps-preflight classify — fail on any update", () => {
    it("passes a fresh tree (nothing outdated)", () => {
        const { blockers, excused } = classify({}, {}, []);
        assert.deepEqual(blockers, []);
        assert.deepEqual(excused, []);
    });

    it("blocks an outdated package with no waiver", () => {
        const { blockers, excused } = classify(OUT, {}, []);
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].name, "linkedom");
        assert.equal(blockers[0].latest, "1.0.0");
    });

    it("excuses an outdated package with a complete waiver", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, []);
        assert.equal(blockers.length, 0);
        assert.equal(excused.length, 1);
        assert.equal(excused[0].name, "linkedom");
    });

    it("blocks an incomplete waiver (missing issue)", () => {
        const { blockers, excused } = classify(OUT, { linkedom: { reason: "later", lane: "mimetypes" } }, []);
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
    });

    it("ownerVeto outranks a complete waiver — blocks and flags it vetoed", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, ["linkedom"]);
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].vetoed, true);
    });

    it("handles npm's array shape (one dep outdated across several workspaces)", () => {
        const arr = { turndown: [{ current: "7.2.0", latest: "7.2.4" }, { current: "7.2.0", latest: "7.2.4" }] };
        const { blockers } = classify(arr, {}, []);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].latest, "7.2.4");
    });
});
