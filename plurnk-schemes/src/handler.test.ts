import test from "node:test";
import { strict as assert } from "node:assert";
import type { SchemeHandler, PassthroughResult } from "./index.ts";

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

test("SchemeHandler: a partial handler (read+send only) satisfies the contract", () => {
    assert.equal(typeof httpLike.read, "function");
    assert.equal(typeof httpLike.send, "function");
    // Unimplemented ops are simply absent — the engine maps op→method and
    // returns 501 when the method is missing, so optionality IS the contract.
    assert.equal(httpLike.find, undefined);
    assert.equal(httpLike.exec, undefined);
});
