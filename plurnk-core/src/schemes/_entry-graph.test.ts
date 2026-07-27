import test from "node:test";
import assert from "node:assert/strict";
import EntryGraph from "./_entry-graph.ts";

test("EntryGraph.storeBatch reads and validates the service-owned persistence knob", () => {
    const prior = process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH;
    try {
        process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = "37";
        assert.equal(EntryGraph.storeBatch(), 37);
        process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = "0";
        assert.throws(() => EntryGraph.storeBatch(), /positive safe integer/);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH;
        else process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = prior;
    }
});
