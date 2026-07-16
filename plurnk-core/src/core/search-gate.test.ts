// [§search-gate] unit tier — the gate's accounting logic (#406, owner ruling: duplicates
// strike-and-serve; the per-turn cap refuses; rail-family lifecycle).
import test from "node:test";
import assert from "node:assert/strict";
import SearchGate from "./search-gate.ts";

const withKnobs = (fn: () => void): void => {
    const pr = process.env.PLURNK_SERVICE_SEARCH_RUNTIMES;
    const pc = process.env.PLURNK_SERVICE_SEARCH_MAX_PER_TURN;
    process.env.PLURNK_SERVICE_SEARCH_RUNTIMES = "search";
    process.env.PLURNK_SERVICE_SEARCH_MAX_PER_TURN = "2";
    try { fn(); } finally {
        if (pr === undefined) delete process.env.PLURNK_SERVICE_SEARCH_RUNTIMES; else process.env.PLURNK_SERVICE_SEARCH_RUNTIMES = pr;
        if (pc === undefined) delete process.env.PLURNK_SERVICE_SEARCH_MAX_PER_TURN; else process.env.PLURNK_SERVICE_SEARCH_MAX_PER_TURN = pc;
    }
};

test("[§search-gate] non-search runtimes pass untouched, always", () => {
    withKnobs(() => {
        const g = new SearchGate();
        assert.deepEqual(g.check(1, 1, "sh", "ls"), { verdict: "pass" });
        g.registerPending(1, 1, "sh", "ls", "/1/1/1"); g.settle("/1/1/1", 200);
        assert.deepEqual(g.check(1, 1, "sh", "ls"), { verdict: "pass" }, "sh never dedups — the gate is search-only");
    });
});

test("[§search-gate] an identical duplicate in the same loop yields the prior coordinate; a fresh loop starts clean", () => {
    withKnobs(() => {
        const g = new SearchGate();
        assert.deepEqual(g.check(1, 1, "search", "capital of france"), { verdict: "pass" });
        g.registerPending(1, 1, "search", "capital of france", "/1/1/2"); g.settle("/1/1/2", 200);
        assert.deepEqual(g.check(1, 2, "search", "capital of france"), { verdict: "duplicate", priorPathname: "/1/1/2" }, "same loop, later turn — still a duplicate");
        assert.deepEqual(g.check(2, 5, "search", "capital of france"), { verdict: "pass" }, "another loop is a fresh conversation");
        assert.deepEqual(g.check(1, 2, "search", "capital of GERMANY"), { verdict: "pass" }, "a different query is not a duplicate");
    });
});

test("[§search-gate] the per-turn cap refuses the (N+1)th DISTINCT search; the next turn resets", () => {
    withKnobs(() => {
        const g = new SearchGate();
        g.registerPending(1, 7, "search", "q1", "/1/1/1"); g.settle("/1/1/1", 200);
        g.registerPending(1, 7, "search", "q2", "/1/1/2"); g.settle("/1/1/2", 200);
        const third = g.check(1, 7, "search", "q3");
        assert.equal(third.verdict, "capped", "cap=2 → the third search this turn refuses");
        assert.deepEqual(g.check(1, 8, "search", "q3"), { verdict: "pass" }, "a new turn resets the counter");
    });
});

test("[§search-gate] duplicate outranks the cap — served results never burn cap headroom", () => {
    withKnobs(() => {
        const g = new SearchGate();
        g.registerPending(1, 7, "search", "q1", "/1/1/1"); g.settle("/1/1/1", 200);
        g.registerPending(1, 7, "search", "q2", "/1/1/2"); g.settle("/1/1/2", 200);
        assert.equal(g.check(1, 7, "search", "q1").verdict, "duplicate", "at the cap, a duplicate still serves rather than 429s");
    });
});

test("[§search-gate] cleanup drops a loop's state at the rail seam", () => {
    withKnobs(() => {
        const g = new SearchGate();
        g.registerPending(1, 1, "search", "q", "/1/1/1"); g.settle("/1/1/1", 200);
        g.cleanup(1);
        assert.deepEqual(g.check(1, 2, "search", "q"), { verdict: "pass" }, "a cleaned loop holds nothing");
    });
});
