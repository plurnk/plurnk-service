import test from "node:test";
import { strict as assert } from "node:assert";
import type {
    EditBatchReceipt,
    EditBatchResult,
    PassthroughResult,
    SchemeHandler,
} from "./index.ts";

// Compile-time contract: a PARTIAL handler (read + send only) satisfies
// SchemeHandler — every op method is optional, so a scheme implements just its
// surface and the engine returns 501 for the rest. Params are contextually
// typed from the interface (ReadStatement / SendStatement / SchemeCtx).
const httpLike: SchemeHandler = {
    async read(_statement, _ctx): Promise<PassthroughResult> {
        return { shape: "passthrough", status: 102 };
    },
    async send(_statement, _ctx): Promise<PassthroughResult> {
        return { shape: "passthrough", status: 200 };
    },
};

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

test("SchemeHandler: a partial handler (read+send only) satisfies the contract", () => {
    assert.equal(typeof httpLike.read, "function");
    assert.equal(typeof httpLike.send, "function");
    // Unimplemented ops are simply absent — the engine maps op→method and
    // returns 501 when the method is missing, so optionality IS the contract.
    assert.equal(httpLike.find, undefined);
    assert.equal(httpLike.exec, undefined);
});

test("SchemeHandler: editBatch exposes the typed aggregate receipt contract", () => {
    assert.equal(typeof editable.editBatch, "function");
    assert.equal(editResult.editReceipt?.unit, "codePoints");
    assert.equal(editResult.editReceipt?.effects[0]?.requested, "<1,2,1,2>");
});
