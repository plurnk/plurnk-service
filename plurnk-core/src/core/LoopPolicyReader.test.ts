import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LOOP_POLICY,
    InvalidLoopPolicyError,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";

test("persisted loop policy is one complete contracts-owned snapshot", () => {
    assert.deepEqual(
        LoopPolicyReader.parse(JSON.stringify(DEFAULT_LOOP_POLICY), 41),
        DEFAULT_LOOP_POLICY,
    );
});

test("every invalid persisted representation fails causally at its loop coordinate", () => {
    const cases = [
        { raw: "{", causeName: "SyntaxError" },
        { raw: "null", causeName: "TypeError" },
        { raw: "[]", causeName: "TypeError" },
        { raw: "{}", causeName: InvalidLoopPolicyError.name },
        { raw: JSON.stringify({ capabilities: {}, proposals: "auto" }), causeName: InvalidLoopPolicyError.name },
        { raw: JSON.stringify({ extra: false }), causeName: InvalidLoopPolicyError.name },
    ];

    for (const { raw, causeName } of cases) {
        assert.throws(
            () => LoopPolicyReader.parse(raw, 41),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /^Loop 41 has invalid persisted policy(?: JSON)?\.$/u);
                assert.ok(error.cause instanceof Error);
                assert.equal(error.cause.constructor.name, causeName);
                return true;
            },
        );
    }
});

test("a missing durable loop is not reinterpreted as default policy", async () => {
    const db = {
        engine_get_loop_policy: { get: async () => undefined },
    } as unknown as Db;
    await assert.rejects(
        LoopPolicyReader.read(db, 41),
        { message: "Loop 41 does not exist while reading its persisted policy." },
    );
});
