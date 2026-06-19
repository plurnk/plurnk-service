import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";

// The persistence envelope (Packet/Turn/Session/Run/Agent/LogEntry) was service-
// internal — produced and consumed only by plurnk-service, never a cross-module
// contract — so it was scrubbed from this package (grammar owns the alphabet, not
// the engine's private composition; see project-grammar-owns-alphabet-not-envelope).
// Loop remains only for its disposition-status enum, the one contract-bearing field.

test("Validator: Loop accepts status 102 (continuing)", () => {
    const { valid, errors } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 102, prompt: "Hello",
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Loop accepts status 200 (terminal ok)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 200, prompt: "Hello",
    });
    assert.equal(valid, true);
});

test("Validator: Loop accepts status 499 (terminal cancel)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 499, prompt: "Hello",
    });
    assert.equal(valid, true);
});

test("Validator: Loop accepts engine-imposed statuses (100/413/429/500/508)", () => {
    for (const status of [100, 413, 429, 500, 508]) {
        const { valid } = Validator.validateLoop({
            id: 1, version: 0, run_id: 1, sequence: 1, status, prompt: "Hello",
        });
        assert.equal(valid, true, `status ${status} should be a valid persisted Loop.status`);
    }
});

test("Validator: Loop rejects status outside the persisted set (e.g. 404)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 404, prompt: "Hello",
    });
    assert.equal(valid, false);
});

test("Validator: Loop rejects sequence 0 (must be 1-based)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 0, status: 102, prompt: "Hello",
    });
    assert.equal(valid, false);
});
