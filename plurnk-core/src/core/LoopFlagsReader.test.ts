import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LOOP_FLAGS,
    InvalidLoopFlagsError,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";

test("persisted partial loop flags expand to the complete contracts-owned value", () => {
    assert.deepEqual(LoopFlagsReader.parse("{}", 41), DEFAULT_LOOP_FLAGS);
    assert.deepEqual(
        LoopFlagsReader.parse(JSON.stringify({ mode: "ask", noWeb: true }), 41),
        { ...DEFAULT_LOOP_FLAGS, mode: "ask", noWeb: true },
    );
});

test("every invalid persisted representation fails causally at its loop coordinate", () => {
    const cases = [
        { raw: "{", causeName: "SyntaxError" },
        { raw: "null", causeName: "TypeError" },
        { raw: "[]", causeName: "TypeError" },
        { raw: JSON.stringify({ mode: "observe" }), causeName: InvalidLoopFlagsError.name },
        { raw: JSON.stringify({ auto: "false" }), causeName: InvalidLoopFlagsError.name },
        { raw: JSON.stringify({ extra: false }), causeName: InvalidLoopFlagsError.name },
    ];

    for (const { raw, causeName } of cases) {
        assert.throws(
            () => LoopFlagsReader.parse(raw, 41),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /^Loop 41 has invalid persisted flags(?: JSON)?\.$/u);
                assert.ok(error.cause instanceof Error);
                assert.equal(error.cause.constructor.name, causeName);
                return true;
            },
        );
    }
});

test("a missing durable loop is not reinterpreted as default policy", async () => {
    const db = {
        engine_get_loop_flags: { get: async () => undefined },
    } as unknown as Db;
    await assert.rejects(
        LoopFlagsReader.read(db, 41),
        { message: "Loop 41 does not exist while reading its persisted flags." },
    );
});
