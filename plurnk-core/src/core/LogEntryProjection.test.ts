import assert from "node:assert/strict";
import test from "node:test";
import LogEntryProjection from "./LogEntryProjection.ts";

for (const runtime of ["sh", "python3", "brave", "search-api", "tool.v2+json"]) {
    test(`{§log-coordinate-hierarchy}: ${runtime} receipts name the invoked runtime`, () => {
        const statement = { runtime, target: null, body: "probe" };
        for (const tx of [statement, JSON.stringify(statement)]) {
            const row = { op: runtime, tx };
            assert.equal(LogEntryProjection.op(row), runtime, "an execution row's op is its runtime, as written");
            assert.equal(LogEntryProjection.leaf(row), runtime);
            assert.equal(LogEntryProjection.coordinate("1/2/3", row), `1/2/3/${runtime}`);
            assert.equal(LogEntryProjection.base(`1/2/3/${runtime}`), "1/2/3");
            assert.equal(LogEntryProjection.base("1/2/3"), "1/2/3");
            assert.equal(LogEntryProjection.accepts(runtime.toUpperCase(), row), true);
            assert.equal(LogEntryProjection.accepts(null, row), true);
            assert.equal(LogEntryProjection.accepts("READ", row), false);
        }
    });
}

test("{§log-coordinate-hierarchy}: native operations and actionless identities are unchanged", () => {
    assert.equal(LogEntryProjection.leaf({ op: "READ" }), "READ");
    assert.equal(LogEntryProjection.leaf({ op: null, attrs: { kind: "emissionAttempt" } }), "attempt");
    assert.equal(LogEntryProjection.leaf({ op: null, attrs: { kind: "emissionAttempt" } }), "attempt");
    assert.equal(LogEntryProjection.leaf({ op: "EDIT", origin: "_plurnk", attrs: { kind: "entry_materialized" } }), "READ");
});

