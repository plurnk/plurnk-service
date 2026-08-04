import assert from "node:assert/strict";
import test from "node:test";
import {
    assertEditBatchReceipt,
    assertEditReceipt,
    assertResourceEffects,
    editReceipt,
    projectEditReceipt,
    reviewerReplacementReceipt,
} from "./edit-receipt.ts";

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

test("editReceipt preserves authored statement correlation while computing snapshot offsets", () => {
    const receipt = editReceipt(
        "one\ntwo\nthree\nfour\n",
        "one\nTWO\n2.5\nthree\nFOUR\n",
        [
            { marker: { marks: [4] }, body: "FOUR" },
            { marker: { marks: [2] }, body: "TWO\n2.5" },
        ],
    );
    assert.deepEqual(receipt.effects.map(({ requested, source, result }) => ({ requested, source, result })), [
        { requested: "<4>", source: "4", result: "5" },
        { requested: "<2>", source: "2", result: "2-3" },
    ]);
});

test("reviewerReplacementReceipt separates one landed replacement from superseded authored EDITs", () => {
    const authored = editReceipt(
        "one\ntwo\nthree\nfour\n",
        "one\nTWO\nthree\nFOUR\n",
        [
            { marker: { marks: [2] }, body: "TWO" },
            { marker: { marks: [4] }, body: "FOUR" },
        ],
    );
    const reviewed = reviewerReplacementReceipt(
        "one\ntwo\nthree\nfour\n",
        "reviewer\nreplacement\n",
        authored,
    );
    assert.deepEqual(reviewed.superseded, ["<2>", "<4>"]);
    assert.deepEqual(reviewed.replacement, {
        requested: "<1,-1>",
        source: "1-4",
        result: "1-2",
        removed: 4,
        inserted: 2,
        context: "1:reviewer\n2:replacement",
    });
    assert.deepEqual(projectEditReceipt(reviewed, 0), {
        revision: reviewed.revision,
        unit: "lines",
        before: 4,
        after: 2,
        disposition: "superseded",
        requested: "<2>",
        replacement: reviewed.replacement,
    });
    assert.deepEqual(projectEditReceipt(reviewed, 1), {
        revision: reviewed.revision,
        unit: "lines",
        before: 4,
        after: 2,
        disposition: "superseded",
        requested: "<4>",
    });
    assert.throws(
        () => reviewerReplacementReceipt("before", "after", reviewed),
        /already replaced/,
    );
});

test("editReceipt reports creation, prepend, append, and deletion boundaries explicitly", () => {
    const cases = [
        { original: "", updated: "a\nb", marker: { marks: [1, -1] as [number, number] }, body: "a\nb", expected: { source: "1^", result: "1-2", removed: 0, inserted: 2 } },
        { original: "b", updated: "a\nb", marker: { marks: [0] as [number] }, body: "a", expected: { source: "1^", result: "1", removed: 0, inserted: 1 } },
        { original: "a", updated: "a\nb", marker: { marks: [-1] as [number] }, body: "b", expected: { source: "2^", result: "2", removed: 0, inserted: 1 } },
        { original: "a\nb", updated: "a", marker: { marks: [2] as [number] }, body: "", expected: { source: "2", result: "2^", removed: 1, inserted: 0 } },
    ];
    for (const { original, updated, marker, body, expected } of cases) {
        const effect = editReceipt(original, updated, [{ marker, body }]).effects[0];
        assert.deepEqual(
            effect === undefined ? undefined : { source: effect.source, result: effect.result, removed: effect.removed, inserted: effect.inserted },
            expected,
        );
    }
});

test("editReceipt reports exact regions in Unicode code points and line-column coordinates", () => {
    const receipt = editReceipt(
        "A😀B\nsecond\n",
        "AXB\nsecond\n",
        [{ marker: { marks: [1, 2, 1, 3] }, body: "X" }],
    );
    assert.equal(receipt.unit, "codePoints");
    assert.equal(receipt.before, 11);
    assert.equal(receipt.after, 11);
    assert.deepEqual(
        receipt.effects.map(({ requested, source, result, removed, inserted }) => ({
            requested,
            source,
            result,
            removed,
            inserted,
        })),
        [{
            requested: "<1,2,1,3>",
            source: "1:2-1:3",
            result: "1:2-1:3",
            removed: 1,
            inserted: 1,
        }],
    );
});

test("editReceipt maps multiline exact insertion endpoints in the resulting revision", () => {
    const receipt = editReceipt(
        "ab\ncd",
        "aX\nYb\ncd",
        [{ marker: { marks: [1, 2, 1, 2] }, body: "X\nY" }],
    );
    assert.deepEqual(
        receipt.effects.map(({ source, result, removed, inserted }) => ({
            source,
            result,
            removed,
            inserted,
        })),
        [{
            source: "1:2^",
            result: "1:2-2:2",
            removed: 0,
            inserted: 3,
        }],
    );
});

test("editReceipt reports mixed line and exact edits in one code-point coordinate system", () => {
    const receipt = editReceipt(
        "one\ntwo\nthree\n",
        "oNe\ntwo\nTHREE\n",
        [
            { marker: { marks: [1, 2, 1, 3] }, body: "N" },
            { marker: { marks: [3] }, body: "THREE" },
        ],
    );
    assert.equal(receipt.unit, "codePoints");
    assert.deepEqual(
        receipt.effects.map(({ source, result, removed, inserted }) => ({
            source,
            result,
            removed,
            inserted,
        })),
        [
            { source: "1:2-1:3", result: "1:2-1:3", removed: 1, inserted: 1 },
            { source: "3:1-4:1", result: "3:1-4:1", removed: 6, inserted: 6 },
        ],
    );
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

test("receipt and resource-effect validators reject malformed plugin results", () => {
    const batch = editReceipt("a", "b", [{
        marker: { marks: [1] },
        body: "b",
    }]);
    assert.equal(assertEditBatchReceipt(batch), batch);
    const receipt = projectEditReceipt(batch, 0);
    assert.equal(assertEditReceipt(receipt), receipt);
    const effects = [{ target: "worker:///notes", action: "update", receipt }] as const;
    assert.equal(assertResourceEffects(effects), effects);
    const creation = projectEditReceipt(editReceipt("", "b", [{
        marker: { marks: [1, -1] },
        body: "b",
    }]), 0);
    const creationEffects = [{ target: "worker:///created", action: "create", receipt: creation }] as const;
    assert.equal(assertResourceEffects(creationEffects), creationEffects);

    assert.throws(
        () => assertEditReceipt({ ...receipt, revision: "short" }),
        /lowercase SHA-256/,
    );
    assert.throws(
        () => assertEditBatchReceipt({ ...batch, effects: [] }),
        /non-empty array/,
    );
    assert.throws(
        () => assertResourceEffects([{ target: "", action: "update" }]),
        /non-empty string/,
    );
    assert.throws(
        () => assertResourceEffects([]),
        /non-empty array/,
    );
    assert.throws(
        () => assertResourceEffects([{ target: "worker:///notes", action: "replace" }]),
        /create.*update.*delete/,
    );
    assert.throws(
        () => assertResourceEffects([{
            target: "worker:///notes",
            action: "delete",
            receipt,
        }]),
        /Only a created or updated resource effect/,
    );
    assert.throws(
        () => assertResourceEffects([{
            target: "worker:///notes",
            action: "create",
            receipt,
        }]),
        /created resource effect receipt.*before extent of zero/,
    );
});
