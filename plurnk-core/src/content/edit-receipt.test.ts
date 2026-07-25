import assert from "node:assert/strict";
import test from "node:test";
import { editReceipt } from "./edit-receipt.ts";

test("editReceipt correlates disjoint edits to one bounded resulting revision", () => {
    const receipt = editReceipt(
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
        "one\nTWO\n2.5\nthree\nfour\nfive\nsix\nseven\nEIGHT\n",
        [
            { marker: { marks: [2] }, body: "TWO\n2.5" },
            { marker: { marks: [8] }, body: "EIGHT" },
        ],
    );
    assert.match(receipt.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual({ unit: receipt.unit, before: receipt.before, after: receipt.after }, { unit: "lines", before: 8, after: 9 });
    assert.deepEqual(receipt.effects.map(({ requested, source, result, removed, inserted }) => ({ requested, source, result, removed, inserted })), [
        { requested: "<2>", source: "2", result: "2-3", removed: 1, inserted: 2 },
        { requested: "<8>", source: "8", result: "9", removed: 1, inserted: 1 },
    ]);
    assert.match(receipt.effects[0]?.context ?? "", /1:one\n2:TWO\n3:2\.5\n4:three/);
    assert.match(receipt.effects[1]?.context ?? "", /7:six\n8:seven\n9:EIGHT/);
    assert.doesNotMatch(receipt.effects[0]?.context ?? "", /6:five/);
});

test("editReceipt fails hard when its context tuning is missing or malformed", () => {
    const prior = process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES;
    try {
        delete process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES;
        assert.throws(() => editReceipt("a", "b", [{ marker: { marks: [1] }, body: "b" }]), /EDIT_RECEIPT_CONTEXT_LINES/);
        process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES = "-1";
        assert.throws(() => editReceipt("a", "b", [{ marker: { marks: [1] }, body: "b" }]), /EDIT_RECEIPT_CONTEXT_LINES/);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES;
        else process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES = prior;
    }
});
