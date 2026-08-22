import test from "node:test";
import { strict as assert } from "node:assert";
import type {
    EditBatchReceipt,
    EditBatchResult,
    RepresentationPreparationResult,
    SchemeHandler,
} from "./index.ts";

// Compile-time contract: a PARTIAL handler (preparation + send only) satisfies
// SchemeHandler — every op method is optional, so a scheme implements just its
// surface and the engine returns 501 for the rest.
const httpLike: SchemeHandler = {
    async prepareRepresentation(_request, _ctx): Promise<RepresentationPreparationResult> {
        return { status: 102 };
    },
    async send(_statement, _ctx) {
        return { status: 200 };
    },
};

// @ts-expect-error Scheme handlers cannot replace core-owned READ projection.
const invalidReadHandler: SchemeHandler = { async read() { return { status: 200 }; } };
void invalidReadHandler;

const editReceipt: EditBatchReceipt = {
    revision: "a".repeat(64),
    unit: "codePoints",
    before: 3,
    after: 4,
    effects: [{
        requested: "<1,2,1,2>",
        source: "1:2-1:2",
        result: "1:2-1:3",
        removed: 0,
        inserted: 1,
        context: "1:xay",
    }],
};

const editResult: EditBatchResult = {
    status: 200,
    editReceipt,
};

const editable: SchemeHandler = {
    async editBatch() {
        return editResult;
    },
};

const callerOwned: SchemeHandler = {
    async resolveEntryAddress(target) {
        return target.kind === "url"
            ? { authority: "", pathname: target.pathname, owner: "worker" }
            : null;
    },
};

test("SchemeHandler: preparation cannot replace core-owned READ projection", () => {
    assert.equal(typeof httpLike.prepareRepresentation, "function");
    assert.equal(typeof httpLike.send, "function");
    // Unimplemented ops are simply absent — the engine maps op→method and
    // returns 501 when the method is missing, so optionality IS the contract.
    assert.equal("read" in httpLike, false);
    assert.equal(httpLike.find, undefined);
    assert.equal(httpLike.exec, undefined);
});

test("SchemeHandler: editBatch exposes the typed aggregate receipt contract", () => {
    assert.equal(typeof editable.editBatch, "function");
    assert.equal(editResult.editReceipt?.unit, "codePoints");
    assert.ok(editResult.editReceipt !== null && editResult.editReceipt !== undefined);
    assert.ok("effects" in editResult.editReceipt);
    assert.equal(editResult.editReceipt.effects[0]?.requested, "<1,2,1,2>");
});

test("SchemeHandler: entry address resolution uses semantic owners instead of storage ids", () => {
    assert.equal(typeof callerOwned.resolveEntryAddress, "function");
});
