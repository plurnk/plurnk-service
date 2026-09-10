import assert from "node:assert/strict";
import test from "node:test";
import LogEntryProjection from "./LogEntryProjection.ts";

for (const executor of [null, "sh", "python3", "brave", "search-api", "tool.v2+json", "4"]) {
    test(`{§log-coordinate-hierarchy}: ${executor ?? "default shell"} receipts name the invoked executor`, () => {
        const runtime = executor ?? "sh";
        const statement = { op: "EXEC", executor, target: null, body: "probe" };
        for (const tx of [statement, JSON.stringify(statement)]) {
            const row = { op: "EXEC", tx };
            assert.equal(LogEntryProjection.op(row), "EXEC", "dispatch identity remains internal");
            assert.equal(LogEntryProjection.leaf(row), runtime);
            assert.equal(LogEntryProjection.coordinate("1/2/3", row), `1/2/3/${runtime}`);
            assert.equal(LogEntryProjection.base(`1/2/3/${runtime}`), "1/2/3");
            assert.equal(LogEntryProjection.base("1/2/3"), "1/2/3");
            assert.equal(LogEntryProjection.accepts(runtime.toUpperCase(), row), true);
            assert.equal(LogEntryProjection.accepts(null, row), true);
            assert.equal(LogEntryProjection.accepts("EXEC", row), false);
            assert.equal(LogEntryProjection.accepts("READ", row), false);
        }
    });
}

test("{§log-coordinate-hierarchy}: native operations and actionless identities are unchanged", () => {
    assert.equal(LogEntryProjection.leaf({ op: "READ" }), "READ");
    assert.equal(LogEntryProjection.leaf({ op: null, attrs: { kind: "turnOps" } }), "ops");
    assert.equal(LogEntryProjection.leaf({ op: null, attrs: { kind: "emissionAttempt" } }), "attempt");
    assert.equal(LogEntryProjection.leaf({ op: "EDIT", origin: "_plurnk", attrs: { kind: "entry_materialized" } }), "READ");
});

test("{§log-coordinate-hierarchy}: an executor identity requires its durable submitted executor", () => {
    for (const tx of [undefined, "{", {}, { executor: 7 }]) {
        assert.throws(() => LogEntryProjection.leaf({ op: "EXEC", tx }), TypeError);
    }
});
