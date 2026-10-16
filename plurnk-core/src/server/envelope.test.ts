import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Envelope from "./envelope.ts";

test("{§workspace-auto-name} redraws a digit-only candidate and samples each character uniformly", (t) => {
    const draws = [0, 1, 2, 3, 4, 9, 10, 61, 0, 9];
    const random = t.mock.method(crypto, "randomInt", (max: number): number => {
        assert.equal(max, 62);
        const next = draws.shift();
        assert.notEqual(next, undefined, "name generation stops at the first nonnumeric candidate");
        return next!;
    });
    assert.equal(Envelope.generateWorkspaceName(), "9Az09");
    assert.equal(random.mock.callCount(), 10);
    assert.deepEqual(draws, []);
});
